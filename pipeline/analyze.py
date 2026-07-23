"""CLI 入口：python analyze.py AAPL → 输出 HTML 诊断报告。"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from analyzer.signals import compute_all_signals
from analyzer.phase import determine_phase
from analyzer.narrative import generate_narrative
from analyzer.renderer import render_html
from analyzer.backtest import (
    DEFAULT_TREND_WINDOW,
    AsOfOutOfRange,
    build_right_trend,
    clamp_trend_window,
    cutoff_daily,
    historical_price_and_change,
    parse_as_of,
    resolve_effective_date,
)
from analyzer.report import build_report_context


def _merge_quote_into_daily_klines(df, quote):
    """用实时 quote 补齐/更新当日日 K，避免收盘后 K 线源晚一天。"""
    if quote is None or quote.price is None or len(df) == 0:
        return df
    if quote.open is None or quote.high is None or quote.low is None:
        return df

    if quote.timestamp:
        quote_date = str(quote.timestamp).split()[0].replace("/", "-")
    else:
        quote_date = datetime.now().strftime("%Y-%m-%d")

    row = {
        "date": quote_date,
        "open": float(quote.open),
        "close": float(quote.price),
        "high": float(quote.high),
        "low": float(quote.low),
        "volume": int(quote.volume or 0),
        "amount": float(quote.amount) if quote.amount is not None else None,
    }

    last_date = str(df["date"].iloc[-1])
    if quote_date == last_date:
        for key, value in row.items():
            df.loc[df.index[-1], key] = value
        return df
    if quote_date > last_date:
        df.loc[len(df)] = row
        return df.reset_index(drop=True)
    return df


def _profile_records(profile) -> list[dict]:
    return [
        {"price_level": b.price_level, "volume": b.volume, "pct": b.pct}
        for b in profile
    ] if profile else []


def _build_volume_profile_windows(ticker: str, days_list=(3, 20, 60), num_bins: int = 30):
    """一次拉取最长分钟 K，再按交易日切分成多个成交密集区窗口。"""
    from data import get_klines
    from data.indicators import build_volume_profile

    bars_per_day = 78
    max_days = max(days_list)
    df = get_klines(ticker, period="5m", count=max_days * bars_per_day)
    if len(df) == 0 or "date" not in df.columns:
        return {}, {}

    date_labels = df["date"].astype(str).str.split().str[0]
    unique_dates = list(dict.fromkeys(date_labels.tolist()))
    profiles = {}
    meta = {}
    for days in days_list:
        selected_dates = unique_dates[-days:]
        if not selected_dates:
            continue
        mask = date_labels.isin(selected_dates)
        window_df = df.loc[mask].copy()
        profile = build_volume_profile(window_df, num_bins=num_bins)
        if not profile:
            continue
        key = f"{days}d"
        profiles[key] = profile
        meta[key] = {
            "requested_days": days,
            "actual_days": len(selected_dates),
            "rows": int(len(window_df)),
            "start_date": selected_dates[0],
            "end_date": selected_dates[-1],
        }
    return profiles, meta


def analyze(
    ticker: str,
    output_dir: str | None = None,
    as_of: str | None = None,
    trend_window: int | None = DEFAULT_TREND_WINDOW,
) -> str:
    """运行完整分析流程，返回生成的 HTML 文件路径。

    `as_of` 为 None 时是当前分析；提供 `as_of`（YYYY-MM-DD）时进入历史复盘：
    按有效交易日截断日线/指数/价格，禁止任何未来数据进入信号计算。
    """
    from data import get_klines, get_quotes

    historical = as_of is not None
    trend_window = clamp_trend_window(trend_window)

    print(f"正在分析 {ticker} ...")

    # 获取数据
    print("  拉取日K线...")
    df = get_klines(ticker, period="1d", count=1260)

    print("  拉取实时行情...")
    try:
        quotes = get_quotes([ticker])
        quote = quotes[0] if quotes else None
    except Exception:
        quote = None

    # ---- 解析有效分析日期 ----
    requested_as_of: str | None = None
    if historical:
        as_of_date = parse_as_of(as_of)
        requested_as_of = as_of_date.strftime("%Y-%m-%d")
        effective_date = resolve_effective_date(df, as_of_date)
        if effective_date is None:
            raise AsOfOutOfRange(f"as_of={requested_as_of} 早于 {ticker} 可用历史首日")
        print(f"  历史复盘：请求 {requested_as_of} → 有效交易日 {effective_date}")
        analysis_df = cutoff_daily(df, effective_date)
    else:
        df = _merge_quote_into_daily_klines(df, quote)
        analysis_df = df
        effective_date = str(df["date"].iloc[-1]).split()[0] if len(df) > 0 else None

    # ---- 成交密集区：历史模式无法保证分钟截断，降级为空 profile ----
    if historical:
        volume_profiles, volume_profile_meta = {}, {}
        vp = []
        volume_profile_mode = "unavailable_historical"
    else:
        print("  构建 Volume Profile...")
        try:
            volume_profiles, volume_profile_meta = _build_volume_profile_windows(ticker)
        except Exception:
            volume_profiles, volume_profile_meta = {}, {}
        vp = volume_profiles.get("20d") or volume_profiles.get("3d") or []
        volume_profile_mode = "current_minute" if vp else "unavailable"

    # ---- 指数环境：历史模式拉长窗口后按有效日期截断 ----
    print("  拉取指数数据...")
    try:
        if historical:
            index_df = get_klines("SPY", period="1d", count=1260)
            index_df = cutoff_daily(index_df, effective_date) if index_df is not None else None
        else:
            index_df = get_klines("SPY", period="1d", count=30)
    except Exception:
        index_df = None

    # 计算信号
    print("  计算信号...")
    signals = compute_all_signals(analysis_df, volume_profile=vp, index_df=index_df)

    # 阶段判断
    phase = determine_phase(signals, df=analysis_df)

    # 生成综述
    name = quote.name if quote and quote.name else ticker
    if historical:
        price, change_pct = historical_price_and_change(analysis_df)
    else:
        price = quote.price if quote else (float(df["close"].iloc[-1]) if len(df) > 0 else None)
        change_pct = quote.change_pct if quote else None
    narrative = generate_narrative(ticker, name, signals, phase)

    # 右侧趋势序列（证伪镜）+ 历史元数据
    print("  构建右侧趋势序列...")
    right_trend = build_right_trend(
        df, effective_date=effective_date, window=trend_window, index_df=index_df,
    )
    report_context = build_report_context(
        df,
        mode="historical" if historical else "current",
        requested_as_of=requested_as_of,
        effective_date=effective_date,
        trend_window=trend_window,
        used_historical_cutoff=historical,
        volume_profile_mode=volume_profile_mode,
    )

    # 准备图表数据
    chart_data = {
        "klines": analysis_df.to_dict("records") if len(analysis_df) > 0 else [],
        "index_klines": index_df[["date", "close"]].to_dict("records") if index_df is not None and len(index_df) > 0 else [],
        "volume_profile": _profile_records(vp),
        "volume_profiles": {
            key: _profile_records(profile)
            for key, profile in volume_profiles.items()
            if profile
        },
        "volume_profile_meta": volume_profile_meta,
    }

    # 渲染 HTML
    html = render_html(
        ticker, name, price, change_pct, signals, phase, narrative,
        chart_data=chart_data,
        report_context=report_context,
        right_trend=right_trend,
    )

    # 保存
    out = Path(output_dir) if output_dir else Path(__file__).parent / "output"
    out.mkdir(parents=True, exist_ok=True)
    if historical:
        suffix = f"asof_{effective_date}"
    else:
        suffix = datetime.now().strftime("%Y%m%d")
    output_path = out / f"{ticker}_{suffix}.html"
    output_path.write_text(html, encoding="utf-8")

    print(f"\n✓ 报告已生成: {output_path}")
    return str(output_path)


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="股票信号分析")
    parser.add_argument("ticker", help="股票代码（如 AAPL、0700.HK）")
    parser.add_argument("--output-dir", help="输出目录（默认 pipeline/output/）")
    parser.add_argument("--as-of", dest="as_of", help="历史复盘日期 YYYY-MM-DD（默认当前分析）")
    parser.add_argument(
        "--trend-window", dest="trend_window", type=int, default=DEFAULT_TREND_WINDOW,
        help=f"右侧趋势序列窗口（默认 {DEFAULT_TREND_WINDOW}）",
    )
    args = parser.parse_args()

    try:
        analyze(
            args.ticker,
            output_dir=args.output_dir,
            as_of=args.as_of,
            trend_window=args.trend_window,
        )
        return 0
    except Exception as e:
        print(f"\n✗ 分析失败: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
