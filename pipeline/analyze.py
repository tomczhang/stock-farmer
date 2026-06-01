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


def analyze(ticker: str, output_dir: str | None = None) -> str:
    """运行完整分析流程，返回生成的 HTML 文件路径。"""
    from data import get_klines, get_quotes, get_volume_profile

    print(f"正在分析 {ticker} ...")

    # 获取数据
    print("  拉取日K线...")
    df = get_klines(ticker, period="1d", count=60)

    print("  拉取实时行情...")
    try:
        quotes = get_quotes([ticker])
        quote = quotes[0] if quotes else None
    except Exception:
        quote = None

    print("  构建 Volume Profile...")
    try:
        vp = get_volume_profile(ticker, days=3, num_bins=30)
    except Exception:
        vp = []

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

    # 渲染 HTML
    html = render_html(ticker, name, price, change_pct, signals, phase, narrative)

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
