"""CLI 入口：python analyze.py AAPL → 输出 HTML 诊断报告。"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from analyzer.signals import compute_all_signals, compute_ma200_levels
from analyzer.phase import determine_phase
from analyzer.narrative import generate_narrative
from analyzer.renderer import render_html


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


def analyze(ticker: str, output_dir: str | None = None) -> str:
    """运行完整分析流程，返回生成的 HTML 文件路径。"""
    from data import get_klines, get_quotes

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

    df = _merge_quote_into_daily_klines(df, quote)

    print("  构建 Volume Profile...")
    try:
        volume_profiles, volume_profile_meta = _build_volume_profile_windows(ticker)
    except Exception:
        volume_profiles, volume_profile_meta = {}, {}
    vp = volume_profiles.get("20d") or volume_profiles.get("3d") or []

    print("  拉取指数数据...")
    try:
        index_df = get_klines("SPY", period="1d", count=30)
    except Exception:
        index_df = None

    # 计算信号
    print("  计算信号...")
    signals = compute_all_signals(df, volume_profile=vp, index_df=index_df)

    # 阶段判断
    phase = determine_phase(signals)

    # 生成综述
    name = quote.name if quote and quote.name else ticker
    price = quote.price if quote else (float(df["close"].iloc[-1]) if len(df) > 0 else None)
    change_pct = quote.change_pct if quote else None
    narrative = generate_narrative(ticker, name, signals, phase)

    # 准备图表数据
    chart_data = {
        "klines": df.to_dict("records") if len(df) > 0 else [],
        "index_klines": index_df[["date", "close"]].to_dict("records") if index_df is not None and len(index_df) > 0 else [],
        "volume_profile": _profile_records(vp),
        "volume_profiles": {
            key: _profile_records(profile)
            for key, profile in volume_profiles.items()
            if profile
        },
        "volume_profile_meta": volume_profile_meta,
        "trend_levels": compute_ma200_levels(df, price),
    }

    # 渲染 HTML
    html = render_html(ticker, name, price, change_pct, signals, phase, narrative, chart_data=chart_data)

    # 保存
    out = Path(output_dir) if output_dir else Path(__file__).parent / "output"
    out.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y%m%d")
    output_path = out / f"{ticker}_{date_str}.html"
    output_path.write_text(html, encoding="utf-8")

    print(f"\n✓ 报告已生成: {output_path}")
    return str(output_path)


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="股票信号分析")
    parser.add_argument("ticker", help="股票代码（如 AAPL、0700.HK）")
    parser.add_argument("--output-dir", help="输出目录（默认 pipeline/output/）")
    args = parser.parse_args()

    try:
        analyze(args.ticker, output_dir=args.output_dir)
        return 0
    except Exception as e:
        print(f"\n✗ 分析失败: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
