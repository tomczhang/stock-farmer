"""
适配器：把 `~/.claude/skills/global-stock-data/SKILL.md` 里嵌入的 Python 代码块
抽取并执行成本模块的属性，让 pipeline 代码可以 `from global_stock_data import stock_kline_yahoo` 直接使用。

这样做的好处：
- 不需要把 1400 行 skill 代码复制粘贴进项目，skill 更新后自动跟进。
- SKILL.md 路径可由 GLOBAL_STOCK_DATA_SKILL_PATH 环境变量覆盖，方便 CI 把 skill 文件下载到任意位置。

SKILL.md 里混着 "使用示例" 代码块（直接调用网络接口），这些会在 import 阶段发起真实 HTTP 调用
甚至引用尚未加载的函数。本模块用 AST 过滤掉这类顶级表达式 / 调用，只保留 def / class / import /
常量赋值这些定义性语句。
"""
from __future__ import annotations

import ast
import os
import re
import sys
from pathlib import Path


_DEFAULT_SKILL_PATH = Path.home() / ".claude" / "skills" / "global-stock-data" / "SKILL.md"
_CODE_BLOCK_RE = re.compile(r"^```python\s*\n(.*?)^```\s*$", re.MULTILINE | re.DOTALL)


def _resolve_skill_path() -> Path:
    env = os.getenv("GLOBAL_STOCK_DATA_SKILL_PATH")
    if env:
        return Path(env)
    return _DEFAULT_SKILL_PATH


def _is_definition_node(node: ast.stmt) -> bool:
    """只保留定义性的顶级语句，过滤掉示例调用 / 顶级 print / 等。"""
    if isinstance(
        node,
        (
            ast.FunctionDef,
            ast.AsyncFunctionDef,
            ast.ClassDef,
            ast.Import,
            ast.ImportFrom,
        ),
    ):
        return True
    if isinstance(node, ast.Assign):
        if not all(isinstance(t, ast.Name) for t in node.targets):
            return False
        # 只保留对常量字面值的赋值；排除任何调用（避免 import 时触发网络请求）
        return _is_pure_value(node.value)
    if isinstance(node, ast.AnnAssign):
        return isinstance(node.target, ast.Name) and (
            node.value is None or _is_pure_value(node.value)
        )
    return False


def _is_pure_value(value: ast.expr) -> bool:
    """字面常量 / 字面集合视为安全；任何包含 Call 的表达式不要在 import 时执行。"""
    if isinstance(value, ast.Constant):
        return True
    if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
        return all(_is_pure_value(e) for e in value.elts)
    if isinstance(value, ast.Dict):
        return all(_is_pure_value(k) for k in value.keys if k is not None) and all(
            _is_pure_value(v) for v in value.values
        )
    return False


def _filter_definitions(source: str) -> str:
    """从一段源码中只保留定义性语句，返回过滤后的源码。"""
    try:
        module = ast.parse(source)
    except SyntaxError:
        return ""
    kept = [node for node in module.body if _is_definition_node(node)]
    if not kept:
        return ""
    module.body = kept
    return ast.unparse(module)


def _extract_definitions(markdown: str) -> str:
    blocks = _CODE_BLOCK_RE.findall(markdown)
    if not blocks:
        raise RuntimeError(
            f"No python code blocks found in skill file {_resolve_skill_path()}."
        )
    pieces = [_filter_definitions(block) for block in blocks]
    pieces = [p for p in pieces if p]
    return "\n\n".join(pieces)


def _load_skill_into_module() -> None:
    skill_path = _resolve_skill_path()
    if not skill_path.exists():
        raise FileNotFoundError(
            f"global-stock-data skill not found at {skill_path}. "
            "Install it via: curl -fsSL -o ~/.claude/skills/global-stock-data/SKILL.md "
            "https://raw.githubusercontent.com/simonlin1212/global-stock-data/main/SKILL.md"
        )
    source = _extract_definitions(skill_path.read_text(encoding="utf-8"))
    exec(source, sys.modules[__name__].__dict__)


_load_skill_into_module()
