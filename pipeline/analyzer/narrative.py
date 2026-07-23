"""综述文本生成（模板拼接，非 LLM）。"""
from __future__ import annotations

from .phase import PhaseResult
from .signals import SignalResult


def generate_narrative(
    ticker: str,
    name: str,
    signals: list[SignalResult],
    phase: PhaseResult,
) -> str:
    left = [s for s in signals if s.category == "left"]
    right = [s for s in signals if s.category == "right"]
    left_green = [s for s in left if s.light == "green"]
    right_green = [s for s in right if s.light == "green"]
    left_yellow = [s for s in left if s.light == "yellow"]
    right_yellow = [s for s in right if s.light == "yellow"]

    # 第一句：当前阶段
    phase_desc = {
        "仍在下跌": "仍处于下跌趋势中，尚未出现有效的底部信号",
        "底部特征初现": "开始出现初步的底部特征，但信号尚不充分",
        "底部初现+右侧确认": "底部特征初现的同时右侧信号已确认，出现信号共振",
        "底部基本成型": "呈现较为明确的筑底特征，底部信号基本充分",
        "右侧强势突破": "左侧底部特征尚不充分，但右侧信号已强势突破，买方强力介入",
        "右侧初步确认": "已初步确认右侧趋势反转，多个确认信号出现",
        "趋势已确立": "趋势已基本确立，左右侧信号充分一致",
        "趋势运行中": (
            "已经处于上升趋势中。本工具专注于捕捉底部反转买点，"
            "对趋势中途的个股不会给出右侧反转信号——当前低分代表"
            "“不是反转买点”，并非看空"
        ),
    }
    sent1 = f"{ticker} ({name}) 当前{phase_desc.get(phase.phase, '状态待定')}。"

    # 趋势运行中：信号面是"为什么没有反转买点"，不必走筑底/反转那套叙述。
    if phase.phase == "趋势运行中":
        return (
            f"{sent1}"
            "底部反转类信号（缩量筑底、跌不动、假破位收回等）天然不会在趋势中途触发，"
            "因此本框架确认度偏低属于正常现象。"
            f"建议：{phase.action}。{phase.trigger}。"
            "如需判断趋势是否健康，请结合证伪镜中确认度与价格的背离情况解读。"
        )

    # 第二句：左侧信号概述
    if left_green:
        green_names = "、".join(s.name for s in left_green[:3])
        sent2 = f"左侧信号方面，{green_names}等 {len(left_green)} 项信号确认，"
        if left_yellow:
            sent2 += f"另有 {len(left_yellow)} 项在酝酿中。"
        else:
            sent2 += "底部特征较为充分。"
    elif left_yellow:
        sent2 = f"左侧信号方面，有 {len(left_yellow)} 项信号出现迹象但均未确认。"
    else:
        sent2 = "左侧信号方面，暂未出现明显的底部特征。"

    # 第三句：右侧信号概述
    if right_green:
        green_names = "、".join(s.name for s in right_green[:3])
        sent3 = f"右侧确认方面，{green_names}已触发，趋势反转信号较强。"
    elif right_yellow:
        yellow_names = "、".join(s.name for s in right_yellow[:2])
        sent3 = f"右侧确认方面，{yellow_names}正在酝酿但尚未确认。"
    else:
        sent3 = "右侧确认信号尚未出现，需等待趋势反转信号。"

    # 第三句补充：左右侧矛盾时的解读
    sent3b = ""
    n_left_green = len(left_green)
    n_right_green = len(right_green)
    if n_right_green >= 3 and n_left_green <= 2:
        sent3b = "值得注意的是，虽然左侧底部特征尚不充分，但买方已强力介入，右侧趋势反转信号明显——属于「未充分筑底即突破」的走势，需关注突破后能否站稳。"
    elif n_left_green >= 3 and n_right_green == 0:
        sent3b = "底部特征已较充分但右侧尚未确认，需耐心等待放量突破信号。"

    # 第四句：操作建议 + 触发条件
    sent4 = f"建议：{phase.action}。{phase.trigger}。"

    return f"{sent1}{sent2}{sent3}{sent3b}{sent4}"
