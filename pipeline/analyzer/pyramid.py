"""金字塔交易回测推演引擎。

选任意标的 + 任意历史时点（as-of），逐日推演右侧纪律打法的完整账本：
入场（筑底基本成立 + 右侧触发）→ 金字塔加仓（越涨越买越少）→
停止买入红线（不追高）→ 倒金字塔减仓（先回本金、底仓做低/负成本）→
止损退出（跌破入场支撑 = 右侧失效）。

防未来函数约定：
- 入场判定逐日按截断数据重算筑底判读与右侧信号；
- 所有决策在收盘后形成，次一交易日以开盘价成交；
- 目标价 / 支撑锚只用入场信号日及之前的数据。

输出为历史模拟账本，仅供研究复盘，不构成投资建议或收益承诺。
"""
from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import numpy as np
import pandas as pd

from .backtest import cutoff_daily, parse_as_of, resolve_effective_date
from .bottoming import SIGN_EARLY_THRESHOLD, compute_bottoming
from .signals import _calc_atr, compute_all_signals

# 入场认可的右侧触发信号（复用 compute_all_signals 中全部 5 个右侧信号）
RIGHT_TRIGGER_IDS = (
    "above_ma", "volume_breakout", "support_retest_hold",
    "macd_cross", "higher_low",
)
# 入场认可的筑底判读档位
ENTRY_TIERS = ("base_forming", "base_ready")

DISCLAIMER = "历史模拟，仅供研究复盘，不构成投资建议或收益承诺。"


@dataclass(frozen=True)
class PyramidParams:
    """推演参数，全部可配置；默认值与用户确认的纪律一致。"""

    budget: float = 1_000_000.0        # 总预算
    entry_fraction: float = 0.20       # 首仓占预算比例
    add_step_pct: float = 0.05         # 加仓档间距（相对入场价）
    add_ratios: tuple[float, ...] = (1.0, 0.5, 0.3)  # 底仓:档2:档3 资金比例
    stop_buy_progress: float = 0.80    # 走完目标空间比例后触发停止买入红线
    trim_space_progress: float = 0.60  # 减仓触发之一：走完目标空间比例
    trim_gain_pct: float = 0.20        # 减仓触发之二：较持仓成本浮盈比例
    trim_step_pct: float = 0.05         # 减仓档间距（相对减仓触发价）
    trim_ratios: tuple[float, ...] = (30.0, 50.0, 80.0)  # 各批卖出相对比例（递增）
    trim_total_fraction: float = 0.90    # 减仓总卖出占启动时仓位比例，剩余即底仓
    stop_loss_atr_mult: float = 0.5    # 止损缓冲 ATR 倍数
    stop_loss_pct_buffer: float = 0.005  # 止损缓冲价格比例下限
    fee_rate: float = 0.001            # 双边手续费率
    hk_lot: int = 100                  # 港股一手股数
    window: int = 120                  # 回测窗口（交易日）
    target_fallback_pct: float = 0.20  # 无压力位时目标价回退涨幅
    target_min_space_pct: float = 0.08  # 目标价最小空间：更近的压力不作目标，否则梯度/红线无意义
    # 强右侧通道（第二入场路径）：适配放量深 V 反转——筑底不达标但
    # 右侧多信号强共振 + 假破位收回初现，允许减半仓位入场
    strong_right_enabled: bool = True
    strong_right_min_green: int = 3        # 右侧 5 信号中绿灯数门槛
    strong_right_fraction: float = 0.5     # 首仓相对标准入场的折扣
    # 强右侧紧止损：深 V 入场位常远高于底部支撑，若支撑距入场超阈值，
    # 止损上收到入场价下方固定比例——小仓试探配试探性止损
    strong_right_max_support_gap: float = 0.08  # 支撑距入场价超此比例时启用紧止损
    strong_right_stop_pct: float = 0.07         # 紧止损：入场价下方比例


def _is_hk(ticker: str) -> bool:
    return ticker.upper().endswith(".HK")


def _round_shares(shares: float, ticker: str, params: PyramidParams) -> int:
    """港股按整手向下取整，美股按整股向下取整。"""
    if _is_hk(ticker) and params.hk_lot > 1:
        return int(shares // params.hk_lot) * params.hk_lot
    return int(shares)


# ---------- 目标价：技术压力位识别 ----------

def _resistance_target(
    day_df: pd.DataFrame,
    entry_price: float,
    params: PyramidParams,
) -> dict[str, Any]:
    """在入场价上方 3%~40% 区间找最近的强压力中枢作为预期目标价。

    候选：近 250 日 swing high（3 日窗口局部高点）+ 日线 Volume Profile
    高量桶价位；按 ATR 容忍度聚类，优先取候选数 ≥2 的聚类中枢。
    下沿受 target_min_space_pct 约束：离入场价太近的压力不作目标
    （否则加仓梯度与停买红线无空间可展开）。无候选时回退
    entry × (1 + target_fallback_pct)。
    """
    fallback = {
        "price": round(entry_price * (1 + params.target_fallback_pct), 4),
        "source": "fallback",
        "basis": f"无可识别压力位，回退入场价 +{params.target_fallback_pct*100:.0f}%",
    }
    if day_df is None or len(day_df) < 30:
        return fallback

    tail = day_df.iloc[-250:]
    highs = tail["high"].astype(float).values
    n = len(highs)
    atr = _calc_atr(day_df, 20)

    candidates: list[float] = []
    swing = 3
    for i in range(swing, n - swing):
        window = highs[i - swing:i + swing + 1]
        if highs[i] >= float(np.max(window)):
            candidates.append(float(highs[i]))

    # Volume Profile 高量桶（前 5 桶）价位也视作压力候选
    try:
        from pipeline.data.indicators import build_volume_profile
    except ModuleNotFoundError:  # pragma: no cover - 测试根导入
        from data.indicators import build_volume_profile
    profile = build_volume_profile(tail, num_bins=25)
    if profile:
        top_bins = sorted(profile, key=lambda b: b.volume, reverse=True)[:5]
        candidates.extend(float(b.price_level) for b in top_bins)

    lo = entry_price * (1 + max(0.03, params.target_min_space_pct))
    hi = entry_price * 1.40
    above = sorted(c for c in candidates if lo <= c <= hi)
    if not above:
        return fallback

    tol = max(atr * 0.5, entry_price * 0.01)
    clusters: list[list[float]] = []
    for price in above:
        if clusters and price - float(np.mean(clusters[-1])) <= tol:
            clusters[-1].append(price)
        else:
            clusters.append([price])

    strong = [c for c in clusters if len(c) >= 2]
    chosen = (strong or clusters)[0]  # 已按价格升序，取入场价上方最近一档
    center = float(np.mean(chosen))
    return {
        "price": round(center, 4),
        "source": "technical",
        "basis": f"近250日压力聚类（{len(chosen)}个候选，含前高/密集成交区）",
    }


# ---------- 支撑锚（止损线） ----------

def _support_anchor(signals: list, entry_price: float) -> dict[str, Any]:
    """入场信号日支撑锚：active_support 下沿 → prev_low → 入场价 × 0.92。"""
    by_id = {s.id: s for s in signals}
    fb = by_id.get("false_breakdown")
    if fb is not None:
        active = (fb.data or {}).get("active_support") or {}
        low = float(active.get("low", 0) or 0)
        if low > 0:
            return {"price": low, "source": "active_support"}
    nn = by_id.get("no_new_low")
    if nn is not None:
        prev_low = float((nn.data or {}).get("prev_low", 0) or 0)
        if 0 < prev_low < entry_price:
            return {"price": prev_low, "source": "prev_low"}
    return {"price": round(entry_price * 0.92, 4), "source": "entry_fallback"}


# ---------- 入场判定 ----------

def check_entry(day_df: pd.DataFrame, params: PyramidParams | None = None) -> dict[str, Any]:
    """单日入场判定，两条路径：

    1. bottoming（标准）：筑底判读 ≥ 基本成立 且 任一右侧触发信号绿灯；
    2. strong_right（可选）：右侧 ≥N 个绿灯且假破位收回迹象 ≥ 初现，
       适配未充分筑底的深 V 反转，仓位减半（strong_right_fraction）。
    """
    params = params or PyramidParams()
    signals = compute_all_signals(day_df)
    verdict = compute_bottoming(day_df, signals=signals)
    trigger_green = [
        s.id for s in signals
        if s.id in RIGHT_TRIGGER_IDS and s.light == "green"
    ]
    right_green_all = [
        s.id for s in signals if s.category == "right" and s.light == "green"
    ]

    mode: str | None = None
    if verdict.tier in ENTRY_TIERS and trigger_green:
        mode = "bottoming"
    elif (
        params.strong_right_enabled
        and verdict.tier != "trend_running"
        and len(right_green_all) >= params.strong_right_min_green
    ):
        fb_sign = next(
            (s for s in getattr(verdict, "signs", []) if s.id == "false_break_recover"),
            None,
        )
        if fb_sign is not None and fb_sign.score >= SIGN_EARLY_THRESHOLD:
            mode = "strong_right"

    return {
        "ok": mode is not None,
        "mode": mode,
        "tier": verdict.tier,
        "tier_label": verdict.tier_label,
        "right_green": trigger_green,
        "right_green_all": right_green_all,
        "cleanliness_pct": verdict.cleanliness_pct,
        "signals": signals,
    }


# ---------- 主推演 ----------

def run_pyramid_backtest(
    df: pd.DataFrame,
    ticker: str,
    as_of: str,
    params: PyramidParams | None = None,
    entry_checker=None,
) -> dict[str, Any]:
    """逐日推演金字塔交易，返回 JSON 可序列化账本 payload。

    `entry_checker` 仅供 demo / 测试注入确定性入场；缺省走真实判读链。
    """
    params = params or PyramidParams()
    as_of_date = parse_as_of(as_of)
    effective = resolve_effective_date(df, as_of_date)
    if effective is None:
        raise ValueError(f"as_of={as_of} 早于 {ticker} 可用历史首日")

    labels = [str(v).split()[0] for v in df["date"].tolist()]
    start_idx = len(labels) - 1 - labels[::-1].index(effective)
    end_idx = min(start_idx + params.window, len(df) - 1)

    opens = df["open"].astype(float).values
    closes = df["close"].astype(float).values

    trades: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    ledger: list[dict[str, Any]] = []
    pending_orders: list[dict[str, Any]] = []

    # 账户状态
    shares = 0
    invested = 0.0
    recovered = 0.0
    entered = False
    entry_fill_price: float | None = None
    entry_signal: dict[str, Any] | None = None
    support: dict[str, Any] | None = None
    target: dict[str, Any] | None = None
    add_tiers: list[dict[str, Any]] = []
    stop_buy = False
    trim_started = False
    trim_tiers: list[dict[str, Any]] = []
    stop_loss_hit = False
    finished = False
    entry_cash = params.budget * params.entry_fraction

    def _fee(amount: float) -> float:
        return amount * params.fee_rate

    def _fill(order: dict[str, Any], i: int) -> None:
        """以第 i 日开盘价撮合订单。"""
        nonlocal shares, invested, recovered, entered, entry_fill_price
        nonlocal support, target, add_tiers, finished
        price = float(opens[i])
        if order["action"] in ("buy", "add"):
            qty = _round_shares(order["cash"] / price, ticker, params)
            if qty <= 0:
                events.append({
                    "type": "skip_buy", "date": labels[i],
                    "reason": "资金不足一手/一股，跳过", "tier": order.get("tier"),
                })
                return
            amount = qty * price
            fee = _fee(amount)
            shares += qty
            invested += amount + fee
            trades.append({
                "date": labels[i], "action": order["action"], "price": round(price, 4),
                "shares": qty, "amount": round(amount, 2), "fee": round(fee, 2),
                "tier": order.get("tier"), "tier_price": order.get("tier_price"),
                "reason": order["reason"],
            })
            if order["action"] == "buy":
                entered = True
                entry_fill_price = price
                # 入场成交后锚定目标价 / 支撑 / 加仓档（只用信号日及之前数据）
                day_df = order["signal_df"]
                target = _resistance_target(day_df, price, params)
                support = _support_anchor(order["signals"], price)
                # 强右侧紧止损：支撑距入场价过远时，止损上收到入场价下方固定比例
                if order.get("mode") == "strong_right" and price > 0:
                    gap = (price - float(support["price"])) / price
                    if gap > params.strong_right_max_support_gap:
                        tight = round(price * (1 - params.strong_right_stop_pct), 4)
                        if tight > float(support["price"]):
                            support = {
                                "price": tight,
                                "source": "strong_right_tight",
                                "raw_price": float(support["price"]),
                                "raw_source": support["source"],
                            }
                add_tiers.clear()
                for k, ratio in enumerate(params.add_ratios[1:], start=1):
                    add_tiers.append({
                        "tier": k,
                        "price": round(price * (1 + k * params.add_step_pct), 4),
                        "cash": entry_cash * ratio,
                        "done": False, "void": False,
                    })
        else:  # trim / stop_loss / exit
            qty = int(order["shares"])
            qty = min(qty, shares)
            if qty <= 0:
                return
            amount = qty * price
            fee = _fee(amount)
            shares -= qty
            recovered += amount - fee
            trades.append({
                "date": labels[i], "action": order["action"], "price": round(price, 4),
                "shares": qty, "amount": round(amount, 2), "fee": round(fee, 2),
                "tier": order.get("tier"), "tier_price": order.get("tier_price"),
                "reason": order["reason"],
            })
            if order["action"] == "stop_loss":
                finished = True

    orders: list[dict[str, Any]] = []
    last_i = start_idx
    for i in range(start_idx, end_idx + 1):
        last_i = i
        # 1) 先撮合前一日收盘形成的订单（次日开盘成交）
        for order in orders:
            _fill(order, i)
        orders = []
        if finished:
            _append_ledger(ledger, labels[i], closes[i], shares, invested, recovered)
            break

        close = float(closes[i])
        date = labels[i]

        if not entered:
            # 2a) 入场判定（逐日截断重算）
            day_df = cutoff_daily(df, date)
            entry = (
                entry_checker(day_df) if entry_checker is not None
                else check_entry(day_df, params)
            )
            if entry["ok"]:
                mode = entry.get("mode") or "bottoming"
                if mode == "strong_right":
                    entry_cash = (
                        params.budget * params.entry_fraction * params.strong_right_fraction
                    )
                    n_green = len(entry.get("right_green_all", []) or entry.get("right_green", []))
                    reason = (
                        f"右侧强共振（{n_green}个绿灯）+假破位收回，未充分筑底，"
                        f"小仓建仓{params.entry_fraction * params.strong_right_fraction * 100:.0f}%"
                    )
                    mode_label = "强右侧通道（小仓）"
                else:
                    entry_cash = params.budget * params.entry_fraction
                    reason = f"筑底基本成立且右侧触发，建仓{params.entry_fraction * 100:.0f}%"
                    mode_label = "筑底成立入场"
                entry_signal = {
                    "signal_date": date,
                    "mode": mode,
                    "mode_label": mode_label,
                    "tier": entry["tier"], "tier_label": entry["tier_label"],
                    "right_green": entry["right_green"],
                    "right_green_all": entry.get("right_green_all", entry["right_green"]),
                    "cleanliness_pct": entry["cleanliness_pct"],
                }
                orders.append({
                    "action": "buy", "cash": entry_cash, "mode": mode,
                    "reason": reason,
                    "signal_df": day_df, "signals": entry["signals"],
                })
        else:
            assert entry_fill_price is not None and target is not None and support is not None
            space = max(target["price"] - entry_fill_price, 1e-9)
            net_cost = (invested - recovered) / shares if shares > 0 else 0.0

            # 2b) 止损优先级最高
            atr = _calc_atr(cutoff_daily(df, date), 20)
            buffer = max(atr * params.stop_loss_atr_mult,
                         support["price"] * params.stop_loss_pct_buffer)
            if shares > 0 and close < support["price"] - buffer:
                orders.append({
                    "action": "stop_loss", "shares": shares,
                    "reason": f"收盘 {close:.2f} 有效跌破支撑 {support['price']:.2f}，右侧失效清仓",
                })
                events.append({
                    "type": "stop_loss", "date": date, "price": close,
                    "support": support["price"], "buffer": round(buffer, 4),
                })
                stop_loss_hit = True
                _append_ledger(ledger, date, close, shares, invested, recovered)
                continue

            # 2c) 停止买入红线（永久）
            progress = (close - entry_fill_price) / space
            if not stop_buy and progress >= params.stop_buy_progress:
                stop_buy = True
                voided = [t for t in add_tiers if not t["done"]]
                for t in voided:
                    t["void"] = True
                events.append({
                    "type": "stop_buy", "date": date, "price": close,
                    "progress_pct": round(progress * 100, 1),
                    "voided_tiers": len(voided),
                    "reason": "价格走完目标空间"
                              f"{params.stop_buy_progress*100:.0f}%，停止一切买入，绝不追高",
                })

            # 2d) 倒金字塔减仓触发与执行
            if not trim_started and shares > 0:
                trigger_price = min(
                    entry_fill_price + space * params.trim_space_progress,
                    net_cost * (1 + params.trim_gain_pct) if net_cost > 0 else float("inf"),
                )
                if close >= trigger_price:
                    trim_started = True
                    # 以启动时仓位为基数：总卖出 = 仓位 × trim_total_fraction，
                    # 各批按 30:50:80 归一化→股数绝对递增，剩余即底仓。
                    ratio_sum = sum(params.trim_ratios) or 1.0
                    sellable = shares * params.trim_total_fraction
                    trim_tiers = [
                        {
                            "tier": k,
                            "price": round(close * (1 + k * params.trim_step_pct), 4),
                            "shares": _round_shares(
                                sellable * ratio / ratio_sum, ticker, params
                            ),
                            "done": False,
                        }
                        for k, ratio in enumerate(params.trim_ratios)
                    ]
                    events.append({
                        "type": "trim_start", "date": date, "price": close,
                        "trigger_price": round(trigger_price, 4),
                        "reason": "达到预期收益，启动倒金字塔分批卖出",
                    })
            if trim_started and shares > 0:
                due = [t for t in trim_tiers if not t["done"] and close >= t["price"]]
                if due:
                    tier = due[0]  # 单日只卖一批
                    tier["done"] = True
                    qty = min(int(tier["shares"]), shares)
                    # 港股整手取整后为 0 但持仓仍够一手：按一手卖，
                    # 避免小仓位时减仓批次全部空转
                    lot = params.hk_lot if _is_hk(ticker) else 1
                    if qty <= 0 and shares >= lot:
                        qty = lot
                    if qty > 0:
                        orders.append({
                            "action": "trim", "shares": qty,
                            "tier": tier["tier"], "tier_price": tier["price"],
                            "reason": f"倒金字塔第{tier['tier']+1}批卖出（批量递增）",
                        })

            # 2e) 金字塔加仓（红线未触发、减仓未启动、止损未发生）
            if not stop_buy and not trim_started:
                due_add = [t for t in add_tiers
                           if not t["done"] and not t["void"] and close >= t["price"]]
                if due_add:
                    tier = due_add[-1]  # 跳空越档只按最高未触发档买一次
                    for t in due_add:
                        t["done"] = True  # 越过的档位一并关闭，不补买
                    orders.append({
                        "action": "add", "cash": tier["cash"],
                        "tier": tier["tier"], "tier_price": tier["price"],
                        "reason": f"金字塔加仓第{tier['tier']+1}档（越涨越买越少）",
                    })

        _append_ledger(ledger, date, close, shares, invested, recovered)

    # 窗口结束仍有未撮合订单 → 待执行
    for order in orders:
        pending_orders.append({
            "action": order["action"],
            "reason": order["reason"],
            "note": "决策日为窗口最后一日，无次日开盘价，标记待执行",
        })

    return _build_payload(
        ticker=ticker, as_of=as_of, effective_date=effective,
        window_start=labels[start_idx], window_end=labels[last_i],
        params=params, entry_signal=entry_signal, entry_fill_price=entry_fill_price,
        support=support, target=target,
        trades=trades, events=events, ledger=ledger, pending=pending_orders,
        shares=shares, invested=invested, recovered=recovered,
        last_close=float(closes[last_i]),
        stop_buy=stop_buy, trim_started=trim_started, stop_loss_hit=stop_loss_hit,
        klines=df.iloc[start_idx:last_i + 1],
    )


def _append_ledger(
    ledger: list[dict[str, Any]],
    date: str, close: float, shares: int, invested: float, recovered: float,
) -> None:
    net_cost = (invested - recovered) / shares if shares > 0 else None
    ledger.append({
        "date": date,
        "close": round(float(close), 4),
        "shares": shares,
        "net_cost": round(net_cost, 4) if net_cost is not None else None,
        "invested": round(invested, 2),
        "recovered": round(recovered, 2),
        "position_value": round(shares * float(close), 2),
        "unrealized": round(shares * float(close) - (invested - recovered), 2)
        if shares > 0 else None,
    })


def _build_payload(
    *,
    ticker: str, as_of: str, effective_date: str,
    window_start: str, window_end: str,
    params: PyramidParams,
    entry_signal: dict[str, Any] | None, entry_fill_price: float | None,
    support: dict[str, Any] | None, target: dict[str, Any] | None,
    trades: list, events: list, ledger: list, pending: list,
    shares: int, invested: float, recovered: float, last_close: float,
    stop_buy: bool, trim_started: bool, stop_loss_hit: bool,
    klines: pd.DataFrame,
) -> dict[str, Any]:
    entered = entry_fill_price is not None
    end_value = shares * last_close
    pnl = recovered + end_value - invested
    net_cost = (invested - recovered) / shares if shares > 0 else None
    summary = {
        "entered": entered,
        "not_entered": not entered,
        "invested": round(invested, 2),
        "recovered": round(recovered, 2),
        "shares": shares,
        "net_cost": round(net_cost, 4) if net_cost is not None else None,
        "negative_cost": bool(net_cost is not None and net_cost < 0),
        "end_value": round(end_value, 2),
        "end_value_note": "未平仓估值（窗口末收盘价）" if shares > 0 else None,
        "pnl": round(pnl, 2),
        "pnl_pct": round(pnl / invested * 100, 2) if invested > 0 else None,
        "stop_buy_triggered": stop_buy,
        "trim_started": trim_started,
        "stop_loss_triggered": stop_loss_hit,
        "pending_orders": len(pending),
    }
    if not entered:
        if pending:
            summary["reason"] = "入场信号在窗口最后一日形成，无次日开盘价，成交待执行"
        else:
            summary["reason"] = "回测窗口内未出现「筑底基本成立 + 右侧触发」入场条件"

    return {
        "ticker": ticker.upper(),
        "as_of": as_of,
        "effective_date": effective_date,
        "window": {"start": window_start, "end": window_end, "days": params.window},
        "params": _params_payload(params),
        "entry": {
            **(entry_signal or {}),
            "fill_price": round(entry_fill_price, 4) if entry_fill_price else None,
            "support": support,
            "target": target,
        } if entered or entry_signal else None,
        "trades": trades,
        "events": events,
        "pending_orders": pending,
        "ledger_series": ledger,
        "summary": summary,
        "verdict_context": entry_signal,
        "chart_data": {"klines": _kline_records(klines)},
        "assumptions": [
            "决策于收盘后形成，次一交易日开盘价成交",
            f"双边手续费 {params.fee_rate*100:.2f}%",
            "港股按一手取整，美股按整股取整",
            "止损锚定入场支撑，推演期内不移动",
        ],
        "disclaimer": DISCLAIMER,
    }


def _kline_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    """日线转纯 Python 类型，保证 JSON 可序列化。"""
    records = []
    for row in df.to_dict("records"):
        records.append({
            "date": str(row.get("date", "")).split()[0],
            "open": float(row.get("open", 0) or 0),
            "high": float(row.get("high", 0) or 0),
            "low": float(row.get("low", 0) or 0),
            "close": float(row.get("close", 0) or 0),
            "volume": int(row.get("volume", 0) or 0),
        })
    return records


def _params_payload(params: PyramidParams) -> dict[str, Any]:
    return {
        "budget": params.budget,
        "entry_fraction": params.entry_fraction,
        "add_step_pct": params.add_step_pct,
        "add_ratios": list(params.add_ratios),
        "stop_buy_progress": params.stop_buy_progress,
        "trim_space_progress": params.trim_space_progress,
        "trim_gain_pct": params.trim_gain_pct,
        "trim_step_pct": params.trim_step_pct,
        "trim_ratios": list(params.trim_ratios),
        "trim_total_fraction": params.trim_total_fraction,
        "fee_rate": params.fee_rate,
        "hk_lot": params.hk_lot,
        "window": params.window,
        "target_fallback_pct": params.target_fallback_pct,
        "strong_right_enabled": params.strong_right_enabled,
        "strong_right_min_green": params.strong_right_min_green,
        "strong_right_fraction": params.strong_right_fraction,
        "strong_right_max_support_gap": params.strong_right_max_support_gap,
        "strong_right_stop_pct": params.strong_right_stop_pct,
    }


# ---------- 数据层入口与 demo ----------

def build_pyramid_backtest(
    ticker: str,
    as_of: str,
    window: int | None = None,
    budget: float | None = None,
) -> dict[str, Any]:
    """拉取日线并执行金字塔回测（server / CLI 入口）。"""
    try:
        from pipeline.data import get_klines
    except ModuleNotFoundError:  # pragma: no cover - 测试根导入
        from data import get_klines

    df = get_klines(ticker, period="1d", count=1260)
    if df is None or len(df) == 0:
        raise ValueError(f"{ticker} 无可用日线数据")
    overrides: dict[str, Any] = {}
    if window is not None:
        overrides["window"] = int(window)
    if budget is not None:
        overrides["budget"] = float(budget)
    params = PyramidParams(**overrides) if overrides else PyramidParams()
    return run_pyramid_backtest(df, ticker, as_of, params=params)


def build_demo_pyramid_backtest(ticker: str = "DEMO") -> dict[str, Any]:
    """确定性演示剧本：入场→三档加仓→红线→三批减仓→负成本底仓。

    用确定性 K 线 + 注入式入场判定驱动真实推演引擎，保证账本逻辑与
    生产路径完全一致，供前端开发调试与 server demo。
    """
    path = [
        (100.0, 100.0), (100.0, 100.0),
        (100.0, 102.0), (102.0, 105.6), (105.0, 106.0),
        (106.0, 110.6), (110.0, 111.0), (111.0, 112.6),
        (112.0, 118.3), (119.0, 124.6), (125.0, 126.0),
        (126.0, 125.0), (125.0, 124.0), (124.0, 125.5),
    ]
    dates = pd.date_range("2026-03-02", periods=len(path), freq="B").strftime("%Y-%m-%d")
    rows = []
    for (o, c), d in zip(path, dates):
        rows.append({
            "date": d, "open": o,
            "high": max(o, c) + 0.8, "low": min(o, c) - 0.8,
            "close": c, "volume": 5_000_000,
        })
    df = pd.DataFrame(rows)

    first_date = str(dates[0])

    def demo_entry(day_df: pd.DataFrame) -> dict[str, Any]:
        d = str(day_df["date"].iloc[-1]).split()[0]
        signals = [
            # 仅供支撑锚使用的最小信号集
            SimpleNamespace(
                id="false_breakdown",
                data={"active_support": {"low": 94.2, "high": 96.8, "strength": 0.72}},
            ),
        ]
        return {
            "ok": d == first_date,
            "tier": "base_forming", "tier_label": "筑底基本成立",
            "right_green": ["above_ma"], "cleanliness_pct": 66,
            "signals": signals,
        }

    payload = run_pyramid_backtest(df, ticker, first_date, entry_checker=demo_entry)
    payload["demo"] = True
    return payload
