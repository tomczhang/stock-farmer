"""stock-farmer pipeline 主入口。

用法：
    python run.py                       # 跑全部 watchlist
    python run.py --market hk           # 只跑港股
    python run.py --ticker AAPL         # 只跑单只
    python run.py --dry-run             # 启用 D1_DRY_RUN，打印 SQL 不执行
    python run.py --force-full-refresh  # 强制全量重拉价格

退出码：
    0 = 失败率 ≤ 10%
    1 = 失败率 > 10%

流程（主路径：雪球 K 线 + 估值，与主流平台口径一致）：
    1. 读 watchlist（or --ticker 单只回填）
    2. 对每只 ticker:
       a. 调雪球 K 线接口拿 [{date, close_adj, pe_ttm}, ...]，本月首次全量、否则增量
       b. 计算 5y/10y/all 三窗口 PE 分位
       c. upsert prices + pe_series
       d. sanity check：调雪球 quote 拿 pe_ttm 与 K 线最新一根对比，差异 > 5% 写 warning
    3. 汇总失败率

为什么用雪球：
    - 直接拿成品 PE-TTM，避免自己拼 TTM (港股 IFRS/Non-IFRS、RMB/HKD、拆股 restate 等坑)
    - 与雪球 / 富途 / Bloomberg 等主流平台口径一致
    - 港美股都覆盖，零密钥（仅需 cookie）

备用路径（fallback，未默认启用）：
    fetcher.prices / fetcher.eps / fetcher.sec_facts +
    compute.ttm / compute.pe 仍保留在代码中。如未来雪球接口变更，
    可在 process_ticker 中切回备用路径。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import traceback
from datetime import date, datetime, timezone

from compute.pe import compute_pe_series
from compute.percentile import compute_percentiles
from compute.ttm import build_ttm_eps
from db.d1_client import D1Client, D1Error
from db.fetch_log import (
    get_last_fetched,
    get_last_full_refresh,
    mark_full_refresh,
    update_last_fetched,
)
from db.writers import (
    load_eps_quarterly,
    load_prices,
    load_watchlist,
    upsert_eps_quarterly,
    upsert_pe_series,
    upsert_prices,
)
from fetcher.eps import fetch_quarterly_eps
from fetcher.prices import fetch_full_history, fetch_incremental
from fetcher.ticker_normalize import market_of, to_yahoo
from fetcher.multpl import fetch_sp500_pe_history
from fetcher.xueqiu import fetch_current_pe, fetch_pe_history

# 指数 ticker → multpl 源
_INDEX_TICKERS = {"SPX"}

_LOG = logging.getLogger("stock_farmer.pipeline")

# 失败率阈值（design.md 决策 10 之 4）
_FAILURE_RATE_THRESHOLD = 0.10

# EPS 拉取节流（fallback 路径用，主路径用雪球时不生效）
_EPS_REFETCH_INTERVAL_SECONDS = 24 * 3600

# sanity check 阈值：雪球 quote 实时 PE vs K 线最新点，差异 > 5% 报警
_PE_DIFF_WARN_RATIO = 0.05

# 默认拉 10 年历史；首次回填用 max，后续增量
_DEFAULT_HISTORY_YEARS = 10


# ---------- 工具 ----------

def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def _should_full_refresh(last_full: datetime | None, today: date) -> bool:
    """本月内没全量刷过 → True。"""
    if last_full is None:
        return True
    return (last_full.year, last_full.month) != (today.year, today.month)


def _should_skip_eps(last_log: dict | None) -> bool:
    if not last_log:
        return False
    last_ts = _parse_iso(last_log.get("last_fetched_at"))
    if not last_ts:
        return False
    age = (_now_utc() - last_ts).total_seconds()
    return age < _EPS_REFETCH_INTERVAL_SECONDS


# ---------- 单 ticker 流程 ----------

def _log_stage(ticker: str, stage: str, t0: float, **extra: object) -> None:
    duration_ms = int((time.time() - t0) * 1000)
    parts = [f"ticker={ticker}", f"stage={stage}", f"duration_ms={duration_ms}"]
    parts.extend(f"{k}={v}" for k, v in extra.items())
    _LOG.info(" ".join(parts))


def _process_prices(
    client: D1Client,
    ticker: str,
    today: date,
    force_full_refresh: bool,
) -> str | None:
    """抓 prices → 写库 → 更新 fetch_log。返回最新数据日期（YYYY-MM-DD）或 None。"""
    t0 = time.time()
    last_full = get_last_full_refresh(client, ticker)
    do_full = force_full_refresh or _should_full_refresh(last_full, today)

    last_log = get_last_fetched(client, ticker, "prices")
    has_existing = bool(last_log and last_log.get("last_data_date"))

    if do_full or not has_existing:
        rows = fetch_full_history(ticker)
        mode = "full"
    else:
        since_str = last_log["last_data_date"]
        try:
            since = date.fromisoformat(since_str)
        except (TypeError, ValueError):
            since = date(1970, 1, 1)
        rows = fetch_incremental(ticker, since)
        mode = "incremental"

    upsert_prices(client, ticker, rows)
    last_date = rows[-1]["date"] if rows else (last_log or {}).get("last_data_date")
    update_last_fetched(client, ticker, "prices", last_data_date=last_date, error=None)
    if do_full:
        mark_full_refresh(client, ticker)
    _log_stage(ticker, f"prices_{mode}", t0, rows=len(rows), last_date=last_date or "none")
    return last_date


def _process_eps(client: D1Client, ticker: str) -> int:
    """抓 EPS → 写库 → 更新 fetch_log。返回写入条数。"""
    t0 = time.time()
    last_log = get_last_fetched(client, ticker, "eps")
    if _should_skip_eps(last_log):
        _log_stage(ticker, "eps_skipped", t0, reason="recent_fetch")
        return 0

    rows = fetch_quarterly_eps(ticker)
    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows_with_ts = [{**r, "fetched_at": fetched_at} for r in rows]
    upsert_eps_quarterly(client, ticker, rows_with_ts)
    last_period = rows[-1]["period_end"] if rows else None
    update_last_fetched(client, ticker, "eps", last_data_date=last_period, error=None)
    _log_stage(ticker, "eps", t0, rows=len(rows), last_period=last_period or "none")
    return len(rows)


def _process_pe_series(client: D1Client, ticker: str) -> int:
    """基于 D1 中全量数据重算 TTM / PE / percentile，并 upsert pe_series。"""
    t0 = time.time()
    prices = load_prices(client, ticker)
    eps_q = load_eps_quarterly(client, ticker)
    if not prices:
        _log_stage(ticker, "pe_series_empty", t0)
        return 0

    price_dates = [p["date"] for p in prices]
    ttm = build_ttm_eps(eps_q, price_dates)
    pe = compute_pe_series(prices, ttm)
    pct = compute_percentiles(pe)
    upsert_pe_series(client, ticker, pct)
    last_date = pct[-1]["date"] if pct else None
    update_last_fetched(client, ticker, "pe_series", last_data_date=last_date, error=None)
    _log_stage(ticker, "pe_series", t0, rows=len(pct), last_date=last_date or "none")
    return len(pct)


def _sanity_check_pe(client: D1Client, ticker: str) -> None:
    """对照 Yahoo trailing_pe，与本地最新 PE 比较；差异 > 10% 写 last_warning。"""
    t0 = time.time()
    try:
        # 延迟导入避免 dry-run 触发未必需要的依赖
        from global_stock_data import key_statistics  # type: ignore
    except Exception as e:  # pragma: no cover
        _LOG.warning("sanity check skipped: cannot import key_statistics: %s", e)
        return

    try:
        stats = key_statistics(to_yahoo(ticker)) or {}
    except Exception as e:
        _log_stage(ticker, "sanity_skip", t0, reason=f"key_statistics_error:{type(e).__name__}")
        return
    yahoo_pe = stats.get("trailing_pe")
    if yahoo_pe in (None, 0):
        _log_stage(ticker, "sanity_skip", t0, reason="yahoo_pe_missing")
        return

    rows = client.query(
        "SELECT pe_ttm FROM pe_series WHERE ticker = ? AND pe_ttm IS NOT NULL "
        "ORDER BY date DESC LIMIT 1",
        [ticker],
    )
    if not rows:
        _log_stage(ticker, "sanity_skip", t0, reason="local_pe_missing")
        return
    local_pe = rows[0].get("pe_ttm")
    if local_pe in (None, 0):
        _log_stage(ticker, "sanity_skip", t0, reason="local_pe_zero")
        return

    diff = abs(float(local_pe) - float(yahoo_pe)) / float(yahoo_pe)
    if diff > _PE_DIFF_WARN_RATIO:
        msg = f"PE diff with Yahoo > {_PE_DIFF_WARN_RATIO*100:.0f}%: local={local_pe} yahoo={yahoo_pe}"
        update_last_fetched(client, ticker, "pe_series", warning=msg)
        _log_stage(ticker, "sanity_warn", t0, diff_pct=round(diff * 100, 2))
    else:
        _log_stage(ticker, "sanity_ok", t0, diff_pct=round(diff * 100, 2))


# ---------- multpl 路径 (指数) ----------

def _process_multpl(
    client: D1Client,
    ticker: str,
    today: date,
    force_full_refresh: bool,
) -> int:
    """multpl 路径：S&P 500 月度 PE 历史 (1871 起)。

    与 _process_xueqiu 类似的语义，只是数据频率从日度变成月度。
    """
    t0 = time.time()
    last_full = get_last_full_refresh(client, ticker)
    do_full = force_full_refresh or _should_full_refresh(last_full, today)
    last_log = get_last_fetched(client, ticker, "prices")

    if do_full or not (last_log and last_log.get("last_data_date")):
        rows = fetch_sp500_pe_history()
        mode = "full"
    else:
        try:
            since = date.fromisoformat(last_log["last_data_date"])
        except (TypeError, ValueError):
            since = None
        rows = fetch_sp500_pe_history(since=since)
        mode = "incremental"

    if not rows:
        _log_stage(ticker, "multpl_empty", t0, mode=mode)
        return 0

    # 写 prices（multpl 价格表也是月度，部分早期可能缺失 close_adj）
    price_rows = [
        {"date": r["date"], "close_adj": r["close_adj"]}
        for r in rows if r["close_adj"] is not None
    ]
    if price_rows:
        upsert_prices(client, ticker, price_rows)

    # 写 pe_series
    pe_rows = [
        {
            "date": r["date"],
            "pe_ttm": r["pe_ttm"],
            "is_loss": r["pe_ttm"] is None or (isinstance(r["pe_ttm"], (int, float)) and r["pe_ttm"] < 0),
        }
        for r in rows
    ]
    # 增量模式下合并 D1 中已有的 PE 序列再算分位
    if mode == "incremental":
        existing = client.query(
            "SELECT date, pe_ttm, is_loss FROM pe_series WHERE ticker = ? ORDER BY date ASC",
            [ticker],
        )
        existing_rows = [
            {"date": r["date"], "pe_ttm": r["pe_ttm"], "is_loss": bool(r["is_loss"])}
            for r in existing
        ]
        by_date = {r["date"]: r for r in existing_rows}
        for r in pe_rows:
            by_date[r["date"]] = r
        pe_rows = sorted(by_date.values(), key=lambda r: r["date"])

    pct = compute_percentiles(pe_rows)
    upsert_pe_series(client, ticker, pct)

    last_date = rows[-1]["date"]
    update_last_fetched(client, ticker, "prices", last_data_date=last_date, error=None)
    update_last_fetched(client, ticker, "pe_series", last_data_date=last_date, error=None)
    if do_full:
        mark_full_refresh(client, ticker)
    _log_stage(ticker, f"multpl_{mode}", t0, rows=len(rows), last_date=last_date)
    return len(pct)


# ---------- 雪球主路径 ----------

def _process_xueqiu(
    client: D1Client,
    ticker: str,
    today: date,
    force_full_refresh: bool,
) -> int:
    """雪球主路径：一次 HTTP 拿到 (date, close_adj, pe_ttm) 全序列，
    直接 upsert prices 和 pe_series，无需自己算 TTM。

    返回写入的 pe_series 行数。
    """
    t0 = time.time()
    last_full = get_last_full_refresh(client, ticker)
    do_full = force_full_refresh or _should_full_refresh(last_full, today)
    last_log = get_last_fetched(client, ticker, "prices")

    if do_full or not (last_log and last_log.get("last_data_date")):
        rows = fetch_pe_history(ticker, years=_DEFAULT_HISTORY_YEARS)
        mode = "full"
    else:
        try:
            since = date.fromisoformat(last_log["last_data_date"])
        except (TypeError, ValueError):
            since = None
        rows = fetch_pe_history(ticker, years=1, since=since)
        mode = "incremental"

    if not rows:
        _log_stage(ticker, "xueqiu_empty", t0, mode=mode)
        return 0

    # 写 prices
    price_rows = [{"date": r["date"], "close_adj": r["close_adj"]} for r in rows]
    upsert_prices(client, ticker, price_rows)

    # 写 pe_series（先转换为 compute_percentiles 要的格式，再算分位）
    pe_rows = [
        {
            "date": r["date"],
            "pe_ttm": r["pe_ttm"],
            "is_loss": r["pe_ttm"] is None or (isinstance(r["pe_ttm"], (int, float)) and r["pe_ttm"] < 0),
        }
        for r in rows
    ]
    # 增量模式下，分位计算需要历史样本——从 D1 读全量已有 PE 再合并
    if mode == "incremental":
        existing = client.query(
            "SELECT date, pe_ttm, is_loss FROM pe_series WHERE ticker = ? ORDER BY date ASC",
            [ticker],
        )
        existing_rows = [
            {
                "date": r["date"],
                "pe_ttm": r["pe_ttm"],
                "is_loss": bool(r["is_loss"]),
            }
            for r in existing
        ]
        by_date = {r["date"]: r for r in existing_rows}
        for r in pe_rows:
            by_date[r["date"]] = r
        pe_rows = sorted(by_date.values(), key=lambda r: r["date"])

    pct = compute_percentiles(pe_rows)
    upsert_pe_series(client, ticker, pct)

    last_date = rows[-1]["date"]
    update_last_fetched(client, ticker, "prices", last_data_date=last_date, error=None)
    update_last_fetched(client, ticker, "pe_series", last_data_date=last_date, error=None)
    if do_full:
        mark_full_refresh(client, ticker)
    _log_stage(ticker, f"xueqiu_{mode}", t0, rows=len(rows), last_date=last_date)
    return len(pct)


def _write_live_snapshot(client: D1Client, ticker: str, quote: dict) -> None:
    """把雪球 quote 写入 fetch_log[data_type='live_snapshot'].last_warning（JSON）。

    Workers 在实时调雪球失败时，可读这个备份做降级。
    """
    snapshot = {
        "snapshot_at": _now_utc().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pe_ttm": quote.get("pe_ttm"),
        "current_price": quote.get("current_price"),
        "eps_ttm": quote.get("eps_ttm"),
        "source": "xueqiu",
    }
    update_last_fetched(
        client,
        ticker,
        "live_snapshot",
        last_data_date=date.today().isoformat(),
        warning=json.dumps(snapshot, ensure_ascii=False),
    )


def _sanity_check_xueqiu(client: D1Client, ticker: str) -> None:
    """对照雪球 quote 实时 pe_ttm，与本地最新 K 线 PE 比较；差异 > 5% 写 warning。

    顺带把 quote 快照写入 fetch_log[data_type='live_snapshot']，供 Workers 降级用。

    注意：quote 在盘后会随个股盘后报价小幅波动；K 线最后一根是当天收盘。
    所以即使数据源完全一致，也会有 < 1% 的细微差异，5% 阈值已经留出余量。
    """
    t0 = time.time()
    try:
        q = fetch_current_pe(ticker)
    except Exception as e:
        _log_stage(ticker, "sanity_skip", t0, reason=f"quote_error:{type(e).__name__}")
        return

    # 无论后续 sanity 是否通过、本地 PE 是否存在，先把 live snapshot 写一份做备份
    try:
        _write_live_snapshot(client, ticker, q)
    except Exception as e:
        _LOG.warning("ticker=%s live_snapshot_write_failed: %s", ticker, e)

    quote_pe = q.get("pe_ttm")
    if quote_pe in (None, 0):
        _log_stage(ticker, "sanity_skip", t0, reason="quote_pe_missing")
        return

    rows = client.query(
        "SELECT pe_ttm FROM pe_series WHERE ticker = ? AND pe_ttm IS NOT NULL "
        "ORDER BY date DESC LIMIT 1",
        [ticker],
    )
    if not rows:
        _log_stage(ticker, "sanity_skip", t0, reason="local_pe_missing")
        return
    local_pe = rows[0].get("pe_ttm")
    if local_pe in (None, 0):
        _log_stage(ticker, "sanity_skip", t0, reason="local_pe_zero")
        return

    diff = abs(float(local_pe) - float(quote_pe)) / float(quote_pe)
    if diff > _PE_DIFF_WARN_RATIO:
        msg = f"PE diff > {_PE_DIFF_WARN_RATIO*100:.0f}%: local={local_pe} xueqiu_quote={quote_pe}"
        update_last_fetched(client, ticker, "pe_series", warning=msg)
        _log_stage(ticker, "sanity_warn", t0, diff_pct=round(diff * 100, 2))
    else:
        _log_stage(ticker, "sanity_ok", t0, diff_pct=round(diff * 100, 2))


def process_ticker(
    client: D1Client,
    ticker: str,
    today: date,
    force_full_refresh: bool,
    enable_sanity_check: bool = True,
) -> None:
    """主流程：按 ticker 类型路由到不同数据源。

    - 指数 (SPX 等) → multpl 月度 PE 历史，无 sanity check
    - 股票 → 雪球日度 PE + 实时 sanity check
    """
    if ticker.upper() in _INDEX_TICKERS:
        _process_multpl(client, ticker.upper(), today, force_full_refresh)
        return
    _process_xueqiu(client, ticker, today, force_full_refresh)
    if enable_sanity_check:
        try:
            _sanity_check_xueqiu(client, ticker)
        except Exception as e:
            _LOG.warning("ticker=%s sanity_check_failed: %s", ticker, e)


def process_ticker_legacy(
    client: D1Client,
    ticker: str,
    today: date,
    force_full_refresh: bool,
    enable_sanity_check: bool = True,
) -> None:
    """备用路径：自己拼 TTM 的旧实现（保留供降级 / 对照用）。"""
    _process_prices(client, ticker, today, force_full_refresh)
    _process_eps(client, ticker)
    _process_pe_series(client, ticker)
    if enable_sanity_check:
        try:
            _sanity_check_pe(client, ticker)
        except Exception as e:
            _LOG.warning("ticker=%s sanity_check_failed: %s", ticker, e)


# ---------- 主入口 ----------

def _build_targets(client: D1Client, args: argparse.Namespace) -> list[dict]:
    if args.ticker:
        return [{"ticker": args.ticker, "market": market_of(args.ticker)}]
    market = None if args.market == "all" else args.market.upper()
    return load_watchlist(client, market=market)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="stock-farmer offline pipeline")
    parser.add_argument("--market", choices=["us", "hk", "all"], default="all")
    parser.add_argument("--ticker", help="单只回填，跳过 watchlist 读取")
    parser.add_argument("--dry-run", action="store_true", help="启用 D1_DRY_RUN，不实际写库")
    parser.add_argument("--force-full-refresh", action="store_true")
    parser.add_argument("--no-sanity-check", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.dry_run:
        os.environ["D1_DRY_RUN"] = "1"

    try:
        client = D1Client()
    except D1Error as e:
        _LOG.error("init D1 client failed: %s", e)
        return 1

    today = _now_utc().date()
    targets = _build_targets(client, args)
    if not targets:
        _LOG.warning("watchlist is empty, nothing to do")
        return 0

    successes = 0
    failures: list[tuple[str, str]] = []

    for entry in targets:
        ticker = entry["ticker"]
        t_start = time.time()
        try:
            process_ticker(
                client,
                ticker,
                today=today,
                force_full_refresh=args.force_full_refresh,
                enable_sanity_check=not args.no_sanity_check,
            )
            successes += 1
            _LOG.info("ticker=%s result=success duration_ms=%d",
                      ticker, int((time.time() - t_start) * 1000))
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            tb = traceback.format_exc(limit=3)
            failures.append((ticker, err))
            _LOG.error("ticker=%s result=failure error=%s\n%s", ticker, err, tb)
            # 写错误到 fetch_log（汇总阶段，单独 try 防止递归失败）
            try:
                update_last_fetched(client, ticker, "prices", error=err)
            except Exception:
                pass

    total = successes + len(failures)
    failure_rate = (len(failures) / total) if total else 0.0
    _LOG.info(
        "summary total=%d success=%d failure=%d failure_rate=%.2f",
        total, successes, len(failures), failure_rate,
    )
    for t, err in failures:
        _LOG.info("failure ticker=%s error=%s", t, err)

    if failure_rate > _FAILURE_RATE_THRESHOLD:
        _LOG.error("failure_rate %.2f > threshold %.2f, exiting non-zero",
                   failure_rate, _FAILURE_RATE_THRESHOLD)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
