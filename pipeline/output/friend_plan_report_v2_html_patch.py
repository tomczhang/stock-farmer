"""2026-08 方案修订的 HTML 补丁：把 friend_plan_report_v2.html 的数据部分
（内联 CH 图表数据 / c11 汇总柱图 / 五场景对比表格）按新版 JSON 重建。

新方案：VOO 侧 T0 一次性打满 + QQQM 侧 30%+12期+阶梯（见 friend_plan_report_v2.py）。
文案段落（方案卡片/怎么读/交换什么等）不在本脚本内，需人工同步。

运行：.venv/bin/python pipeline/output/friend_plan_report_v2_html_patch.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
HTML = OUT / "friend_plan_report_v2.html"
DATA = json.loads((OUT / "friend_plan_report_v2.json").read_text())

PLAN_NAME = "本计划(VOO一次性+纳指阶梯)"
KINDS = ["lump", "dca12", "plan"]
CHART_MAP = {
    "c1": ("main", "deploy"), "c2": ("main", "curves"),
    "c5": ("mid", "deploy"), "c6": ("mid", "curves"),
    "c4": ("sub", "curves"),
    "c7": ("bull", "deploy"), "c8": ("bull", "curves"),
    "c9": ("norm", "deploy"), "c10": ("norm", "curves"),
}
SCENES = [("main", "顶部"), ("bull", "高位续涨"), ("mid", "半山腰下跌"),
          ("sub", "底部"), ("norm", "平凡日子")]


def years_of(scene: dict, kind: str) -> float:
    s, e = scene["start"], scene["stats"][kind]["end_date"]
    return (int(e[:4]) - int(s[:4])) + (int(e[5:7]) - int(s[5:7])) / 12


def fmt_wan(v: float) -> str:
    return f"{v / 1e4:,.1f} 万"


def patch_ch(html: str) -> str:
    m = re.search(r"const CH = (\{.*?\});\n", html, re.S)
    ch = json.loads(m.group(1))
    end_m = DATA["meta"]["data_end"][:7]
    for cid, (scene, field) in CHART_MAP.items():
        for i, kind in enumerate(KINDS):
            ch[cid]["series"][i]["data"] = DATA[scene][field][kind]
        for s in ch[cid]["series"]:
            if s["name"].startswith("本计划"):
                s["name"] = PLAN_NAME
        title = ch[cid]["title"]
        title = re.sub(r"2026-\d{2}", end_m, title)
        title = title.replace("阶梯半月内打完", "纳指阶梯半月内打完")
        title = title.replace("阶梯一次未触发，纯階梯式定投", "阶梯一次未触发，纳指侧纯定投")
        ch[cid]["title"] = title
    return html[:m.start(1)] + json.dumps(ch, ensure_ascii=False) + html[m.end(1):]


def build_c11() -> str:
    vals, raws = {k: [] for k in KINDS}, {k: [] for k in KINDS}
    for scene, _ in SCENES:
        vends = {k: DATA[scene]["stats"][k]["vend"] for k in KINDS}
        best = max(vends.values())
        for k in KINDS:
            vals[k].append(round(vends[k] / best * 100, 1))
            raws[k].append(f"{vends[k] / 1e4:,.1f}万")
    def js(k, label, color):
        return (f"    '{label}': {{color:'{color}', v:{json.dumps(vals[k])}, "
                f"raw:{json.dumps(raws[k], ensure_ascii=False)}}}")
    return ",\n".join([
        js("lump", "一次性买入", "#e5484d"),
        js("dca12", "12个月定投", "#f0a020"),
        js("plan", PLAN_NAME, "#16a34a"),
    ])


def build_rows(scene: str) -> list[str]:
    stats = {k: DATA[scene]["stats"][k] for k in KINDS}
    yrs = years_of(DATA[scene], "lump")
    disp = {}
    for k, s in stats.items():
        ann = (s["vend"] / 1e6) ** (1 / yrs) - 1
        rec = s["recover_years"]
        disp[k] = {
            "v10": round(s["v10"] / 1e4, 1), "vend": round(s["vend"] / 1e4, 1),
            "ann": round(ann * 100, 1), "mdd": round(s["mdd"] * 100, 1),
            "trough": s["trough_date"][:7],
            "rec": -1.0 if not s["hurt"] else (rec if rec is not None else 999.0),
        }
    winners = {
        "v10": max(d["v10"] for d in disp.values()),
        "vend": max(d["vend"] for d in disp.values()),
        "ann": max(d["ann"] for d in disp.values()),
        "mdd": max(d["mdd"] for d in disp.values()),
        "rec": min(d["rec"] for d in disp.values()),
    }
    def cell(val_html: str, win: bool, tie: bool, detail: str = "") -> str:
        badge = f"<span class=winner-badge>{'并列胜出' if tie else '胜出'}</span>" if win else ""
        cls = '"metric-cell is-winner"' if win else "metric-cell"
        return (f"<td class={cls}><span class=metric-value>{val_html}</span>"
                f"{detail}{badge}</td>")
    meta = {"lump": ("plan-lump", "一次性买入", "首日满仓"),
            "dca12": ("plan-dca", "12 个月定投", "平均分批投入"),
            "plan": ("plan-friend", "本计划", "VOO 打满 + 纳指 30%+定投+阶梯")}
    rows = []
    for k in KINDS:
        d = disp[k]
        cls, name, note = meta[k]
        cells = []
        for key, val_html, detail in (
            ("v10", f"{d['v10']:,.1f} 万", ""),
            ("vend", f"{d['vend']:,.1f} 万", ""),
            ("ann", f"{d['ann']:.1f}%", ""),
            ("mdd", f"{d['mdd']:.1f}%", f"<span class=metric-detail>谷底 {d['trough']}</span>"),
        ):
            win = d[key] == winners[key]
            tie = win and sum(1 for x in disp.values() if x[key] == winners[key]) > 1
            cells.append(cell(val_html, win, tie, detail))
        rec = d["rec"]
        rec_html = "未伤本金" if rec == -1.0 else ("数日" if rec == 0.0 else f"{rec} 年")
        win = rec == winners["rec"]
        tie = win and sum(1 for x in disp.values() if x["rec"] == winners["rec"]) > 1
        cells.append(cell(rec_html, win, tie))
        rows.append(f'<tr class=plan-row><th scope=row class="plan-cell {cls}">'
                    f"<span class=plan-name>{name}</span><span class=plan-note>{note}</span></th>"
                    + "".join(cells) + "</tr>\n")
    return rows


def main() -> None:
    html = HTML.read_text()
    html = patch_ch(html)

    # c11 数据块（三行 D 定义）
    m = re.search(r"  const D = \{\n(.*?)\n  \};", html, re.S)
    html = html[:m.start(1)] + build_c11() + html[m.end(1):]

    # 五场景表格：按 <tr class=plan-row> 出现顺序成组替换
    lines = html.splitlines(keepends=True)
    row_idx = [i for i, ln in enumerate(lines) if ln.startswith("<tr class=plan-row>")]
    assert len(row_idx) == 15, f"expect 15 plan rows, got {len(row_idx)}"
    for gi, (scene, _) in enumerate(SCENES):
        for ri, new_row in zip(row_idx[gi * 3:gi * 3 + 3], build_rows(scene)):
            lines[ri] = new_row
    HTML.write_text("".join(lines))

    # 供人工同步文案用的关键数字
    for scene, label in SCENES:
        parts = []
        for k in KINDS:
            s = DATA[scene]["stats"][k]
            parts.append(f"{k}={s['vend'] / 1e4:,.1f}万/mdd{s['mdd'] * 100:.1f}%")
        print(f"{label}: " + "  ".join(parts))
    # 平凡日子场景 plan 建仓进度的最大单日跳升（用于 c9 标题）
    dep = DATA["norm"]["deploy"]["plan"]
    jumps = [(dep[i][0], dep[i][1] - dep[i - 1][1]) for i in range(1, len(dep))]
    d0, j0 = max(jumps, key=lambda x: x[1])
    after = next(v for dt, v in dep if dt >= d0)
    print(f"norm plan 最大跳升: {d0} +{j0:.1f}pp → {after:.1f}%")


if __name__ == "__main__":
    main()
