"""10 个信号的确定度计算。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd


@dataclass
class SignalResult:
    id: str
    name: str
    category: str  # "left" | "right"
    confidence: float  # 0.0 ~ 1.0
    light: str  # "red" | "yellow" | "green"
    thresholds: tuple[float, float]  # (red_max, yellow_max)
    weight: int  # 1 or 2
    description: str
    data: dict = field(default_factory=dict)


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _to_light(confidence: float, thresholds: tuple[float, float]) -> str:
    if confidence >= thresholds[1]:
        return "green"
    if confidence >= thresholds[0]:
        return "yellow"
    return "red"


# ---------- S1: 缩量下跌 ----------

def _calc_vol_shrink(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    vol = df["volume"].values
    if len(vol) < 20:
        return SignalResult(
            id="vol_shrink", name="缩量下跌", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足，无法判断", data={},
        )
    vol5 = float(np.mean(vol[-5:]))
    vol20 = float(np.mean(vol[-20:]))
    ratio = vol5 / vol20 if vol20 > 0 else 1.0
    conf = _clamp((1 - ratio) * 2.0)

    if conf >= thresholds[1]:
        desc = f"5日均量 = 20日均量的 {ratio*100:.0f}%，抛压明显减轻"
    elif conf >= thresholds[0]:
        desc = f"5日均量 = 20日均量的 {ratio*100:.0f}%，轻微缩量"
    else:
        desc = f"5日均量 = 20日均量的 {ratio*100:.0f}%，未缩量"

    return SignalResult(
        id="vol_shrink", name="缩量下跌", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"vol5": vol5, "vol20": vol20, "ratio": ratio},
    )


# ---------- S2: 跌不动 ----------

def _calc_no_new_low(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 25:
        return SignalResult(
            id="no_new_low", name="跌不动", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    lows = df["low"].values
    recent_low = float(np.min(lows[-5:]))
    prev_low = float(np.min(lows[-25:-5]))
    highs = df["high"].values
    atr = float(np.mean(highs[-14:] - lows[-14:]))
    if atr == 0:
        atr = 1.0

    breach = max(0, prev_low - recent_low)
    conf = _clamp(1 - breach / atr)

    if conf >= thresholds[1]:
        desc = f"近5日最低 {recent_low:.2f}，未破前低 {prev_low:.2f}"
    elif conf >= thresholds[0]:
        desc = f"近5日最低 {recent_low:.2f}，轻微破前低 {prev_low:.2f} {breach:.2f}"
    else:
        desc = f"近5日最低 {recent_low:.2f}，有效破前低 {prev_low:.2f}"

    return SignalResult(
        id="no_new_low", name="跌不动", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"recent_low": recent_low, "prev_low": prev_low, "breach": breach},
    )


# ---------- S3: 假破位收回 ----------

def _calc_false_breakdown(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.30, 0.60)
    if len(df) < 25:
        return SignalResult(
            id="false_breakdown", name="假破位收回", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=2,
            description="数据不足", data={},
        )
    lows = df["low"].values
    closes = df["close"].values
    prev_low = float(np.min(lows[-25:-5]))

    # 检查近10日内是否有破前低又收回的情况
    conf = 0.0
    desc = "近期未出现破位后收回形态"
    for i in range(-10, -1):
        if lows[i] < prev_low:
            breach_depth = prev_low - lows[i]
            # 检查后续3日是否收回
            recovery_window = closes[i+1:min(i+4, 0) or len(closes)]
            if len(recovery_window) > 0 and float(np.max(recovery_window)) > prev_low:
                atr = float(np.mean(df["high"].values[-14:] - df["low"].values[-14:]))
                if atr == 0:
                    atr = 1.0
                depth_score = _clamp(1 - breach_depth / atr)
                speed_score = 1.0  # recovered within window
                conf = _clamp((depth_score * 0.5 + speed_score * 0.5))
                desc = f"破前低 {prev_low:.2f} 后快速收回，破位深度 {breach_depth:.2f}"
                break

    return SignalResult(
        id="false_breakdown", name="假破位收回", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=2,
        description=desc, data={"prev_low": prev_low, "conf": conf},
    )


# ---------- S4: 波动收敛 ----------

def _calc_vol_contraction(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 30:
        return SignalResult(
            id="vol_contraction", name="波动收敛", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values
    tr = np.maximum(highs - lows, np.abs(highs - np.roll(closes, 1)))
    atr_recent = float(np.mean(tr[-5:]))
    atr_prev = float(np.mean(tr[-25:-5]))
    if atr_prev == 0:
        atr_prev = 1.0

    decline_ratio = (atr_prev - atr_recent) / atr_prev
    conf = _clamp(decline_ratio / 0.5)

    if conf >= thresholds[1]:
        desc = f"ATR 从 {atr_prev:.2f} 降至 {atr_recent:.2f}，收敛 {decline_ratio*100:.0f}%"
    elif conf >= thresholds[0]:
        desc = f"ATR 轻微下降 {decline_ratio*100:.0f}%，波动开始收敛"
    else:
        desc = f"ATR 未明显下降（{decline_ratio*100:.0f}%），波动仍大"

    return SignalResult(
        id="vol_contraction", name="波动收敛", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"atr_recent": atr_recent, "atr_prev": atr_prev, "decline": decline_ratio},
    )


# ---------- S5: 筹码集中 ----------

def _calc_chip_concentration(volume_profile: list) -> SignalResult:
    thresholds = (0.35, 0.70)
    if not volume_profile:
        return SignalResult(
            id="chip_concentration", name="筹码集中", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="Volume Profile 数据不可用", data={},
        )
    sorted_bins = sorted(volume_profile, key=lambda b: b.volume, reverse=True)
    top3_pct = sum(b.pct for b in sorted_bins[:3])
    conf = _clamp(top3_pct / 60.0)

    if conf >= thresholds[1]:
        desc = f"前3价位桶占总成交量 {top3_pct:.1f}%，筹码高度集中"
    elif conf >= thresholds[0]:
        desc = f"前3价位桶占 {top3_pct:.1f}%，筹码较集中"
    else:
        desc = f"前3价位桶占 {top3_pct:.1f}%，筹码分散"

    return SignalResult(
        id="chip_concentration", name="筹码集中", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"top3_pct": top3_pct},
    )


# ---------- S6: 大盘环境 ----------

def _calc_market_env(index_df: pd.DataFrame | None) -> SignalResult:
    thresholds = (0.35, 0.70)
    if index_df is None or len(index_df) < 20:
        return SignalResult(
            id="market_env", name="大盘环境", category="left",
            confidence=0.5, light="yellow", thresholds=thresholds, weight=1,
            description="指数数据不可用，按中性处理", data={},
        )
    closes = index_df["close"].values
    ma20 = float(np.mean(closes[-20:]))
    current = float(closes[-1])
    atr = float(np.mean(index_df["high"].values[-14:] - index_df["low"].values[-14:]))
    if atr == 0:
        atr = 1.0

    above_ratio = (current - ma20) / atr
    ma_direction = float(np.mean(closes[-5:])) - float(np.mean(closes[-10:-5]))
    direction_score = _clamp(ma_direction / atr + 0.5)

    conf = _clamp((above_ratio * 0.6 + direction_score * 0.4))

    if conf >= thresholds[1]:
        desc = f"指数站上 MA20 ({ma20:.0f})，市场环境偏强"
    elif conf >= thresholds[0]:
        desc = f"指数接近 MA20，市场中性"
    else:
        desc = f"指数在 MA20 下方，市场环境偏弱"

    return SignalResult(
        id="market_env", name="大盘环境", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"index_close": current, "ma20": ma20},
    )


# ---------- S7: 站回均线 ----------

def _calc_above_ma(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 20:
        return SignalResult(
            id="above_ma", name="站回均线", category="right",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    closes = df["close"].values
    close = float(closes[-1])
    ma10 = float(np.mean(closes[-10:]))
    ma20 = float(np.mean(closes[-20:]))
    atr = float(np.mean(df["high"].values[-14:] - df["low"].values[-14:]))
    if atr == 0:
        atr = 1.0

    if close < ma20:
        conf = 0.0
        desc = f"收盘 {close:.2f} 在 MA20 ({ma20:.2f}) 下方"
    else:
        conf = _clamp((close - ma20) / atr)
        if close > ma10:
            desc = f"收盘 {close:.2f} > MA10 ({ma10:.2f}) > MA20 ({ma20:.2f})，均线多头"
        else:
            desc = f"收盘 {close:.2f} 站上 MA20 ({ma20:.2f})，但仍在 MA10 下方"

    return SignalResult(
        id="above_ma", name="站回均线", category="right",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"close": close, "ma10": ma10, "ma20": ma20},
    )


# ---------- S8: 放量反包 ----------

def _calc_volume_breakout(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.75)
    if len(df) < 20:
        return SignalResult(
            id="volume_breakout", name="放量反包", category="right",
            confidence=0.0, light="red", thresholds=thresholds, weight=2,
            description="数据不足", data={},
        )
    closes = df["close"].values
    opens = df["open"].values
    volumes = df["volume"].values
    vol20 = float(np.mean(volumes[-20:]))

    # 找最近的阳线
    conf = 0.0
    desc = "近期无明显放量阳线"
    for i in range(-1, max(-6, -len(df)), -1):
        if closes[i] > opens[i]:  # 阳线
            vol_ratio = float(volumes[i]) / vol20 if vol20 > 0 else 0
            conf = _clamp(vol_ratio - 1.0)
            if conf > 0:
                desc = f"阳线成交量为 20日均量的 {vol_ratio:.1f} 倍"
                break
            else:
                desc = f"阳线成交量 = 20日均量的 {vol_ratio*100:.0f}%，未放量"
                break

    return SignalResult(
        id="volume_breakout", name="放量反包", category="right",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=2,
        description=desc, data={"vol20": vol20, "conf": conf},
    )


# ---------- S9: MACD 金叉 ----------

def _calc_macd_cross(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 35:
        return SignalResult(
            id="macd_cross", name="MACD金叉", category="right",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    closes = pd.Series(df["close"].values)
    ema12 = closes.ewm(span=12).mean()
    ema26 = closes.ewm(span=26).mean()
    dif = ema12 - ema26
    dea = dif.ewm(span=9).mean()

    dif_val = float(dif.iloc[-1])
    dea_val = float(dea.iloc[-1])
    diff = dif_val - dea_val
    atr = float(np.mean(df["high"].values[-14:] - df["low"].values[-14:]))
    if atr == 0:
        atr = 1.0

    if diff > 0:
        conf = _clamp(diff / (atr * 0.1))
        desc = f"DIF ({dif_val:.3f}) 在 DEA ({dea_val:.3f}) 上方，金叉已确认"
    elif diff > -(atr * 0.05):
        conf = _clamp(0.35 + (1 + diff / (atr * 0.05)) * 0.3)
        desc = f"DIF ({dif_val:.3f}) 接近 DEA ({dea_val:.3f})，即将金叉"
    else:
        conf = _clamp(0.2 * (1 + diff / (atr * 0.2)))
        desc = f"DIF ({dif_val:.3f}) 在 DEA ({dea_val:.3f}) 下方，未金叉"

    return SignalResult(
        id="macd_cross", name="MACD金叉", category="right",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"dif": dif_val, "dea": dea_val, "diff": diff},
    )


# ---------- S10: 低点抬升 ----------

def _calc_higher_low(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 30:
        return SignalResult(
            id="higher_low", name="低点抬升", category="right",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    lows = df["low"].values
    # 找两个局部低点：近10日最低 vs 前10-20日最低
    recent_low = float(np.min(lows[-10:]))
    prev_low = float(np.min(lows[-20:-10]))
    atr = float(np.mean(df["high"].values[-14:] - df["low"].values[-14:]))
    if atr == 0:
        atr = 1.0

    uplift = recent_low - prev_low
    if uplift > 0:
        conf = _clamp(uplift / atr)
        desc = f"近期低点 {recent_low:.2f} 高于前低 {prev_low:.2f}，抬升 {uplift:.2f}"
    else:
        conf = 0.0
        desc = f"近期低点 {recent_low:.2f} 未高于前低 {prev_low:.2f}"

    return SignalResult(
        id="higher_low", name="低点抬升", category="right",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"recent_low": recent_low, "prev_low": prev_low, "uplift": uplift},
    )


# ---------- 汇总 ----------

def compute_all_signals(
    df: pd.DataFrame,
    volume_profile: list | None = None,
    index_df: pd.DataFrame | None = None,
) -> list[SignalResult]:
    """计算全部 10 个信号，返回 SignalResult 列表。"""
    return [
        _calc_vol_shrink(df),
        _calc_no_new_low(df),
        _calc_false_breakdown(df),
        _calc_vol_contraction(df),
        _calc_chip_concentration(volume_profile or []),
        _calc_market_env(index_df),
        _calc_above_ma(df),
        _calc_volume_breakout(df),
        _calc_macd_cross(df),
        _calc_higher_low(df),
    ]
