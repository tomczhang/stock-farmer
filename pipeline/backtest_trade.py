"""金字塔交易回测 CLI：生成单页静态 HTML 回测报告。

用法（在 pipeline/ 目录下执行）：
    python backtest_trade.py AAPL --as-of 2025-06-30
    python backtest_trade.py 0700.HK --as-of 2025-03-01 --window 90 --budget 200000
    python backtest_trade.py DEMO --demo          # 确定性演示剧本
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from analyzer.pyramid import build_demo_pyramid_backtest, build_pyramid_backtest
from analyzer.pyramid_renderer import render_pyramid_html


def run(
    ticker: str,
    as_of: str | None,
    window: int | None = None,
    budget: float | None = None,
    output_dir: str | None = None,
    demo: bool = False,
    dump_json: bool = False,
) -> str:
    if demo or ticker.upper() == "DEMO":
        payload = build_demo_pyramid_backtest(ticker)
    else:
        if not as_of:
            raise SystemExit("必须提供 --as-of YYYY-MM-DD（或使用 --demo）")
        print(f"回测 {ticker} @ {as_of} ...")
        payload = build_pyramid_backtest(ticker, as_of, window=window, budget=budget)

    summary = payload["summary"]
    if summary["entered"]:
        print(
            f"  入场 {payload['entry']['fill_price']}，"
            f"交易 {len(payload['trades'])} 笔，"
            f"盈亏 {summary['pnl']}（{summary['pnl_pct']}%），"
            f"底仓 {summary['shares']} 股 净成本 {summary['net_cost']}"
        )
    else:
        print(f"  {summary.get('reason', '未入场')}")

    html = render_pyramid_html(payload)
    out = Path(output_dir) if output_dir else Path(__file__).parent / "output"
    out.mkdir(parents=True, exist_ok=True)
    tag = payload.get("effective_date") or datetime.now().strftime("%Y%m%d")
    output_path = out / f"{ticker.upper()}_pyramid_{tag}.html"
    output_path.write_text(html, encoding="utf-8")
    print(f"\n✓ 回测报告已生成: {output_path}")

    if dump_json:
        json_path = output_path.with_suffix(".json")
        json_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        print(f"✓ 回测账本 JSON: {json_path}")
    return str(output_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="金字塔交易回测")
    parser.add_argument("ticker", help="股票代码（如 AAPL、0700.HK、DEMO）")
    parser.add_argument("--as-of", dest="as_of", help="回测起点日期 YYYY-MM-DD")
    parser.add_argument("--window", type=int, help="回测窗口交易日数（默认 120）")
    parser.add_argument("--budget", type=float, help="总预算（默认 1000000）")
    parser.add_argument("--output-dir", help="输出目录（默认 pipeline/output/）")
    parser.add_argument("--demo", action="store_true", help="使用确定性演示剧本")
    parser.add_argument("--json", dest="dump_json", action="store_true", help="同时输出账本 JSON")
    args = parser.parse_args()
    run(
        args.ticker, args.as_of,
        window=args.window, budget=args.budget,
        output_dir=args.output_dir, demo=args.demo, dump_json=args.dump_json,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
