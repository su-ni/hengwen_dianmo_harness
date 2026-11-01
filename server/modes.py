# -*- coding: utf-8 -*-
"""三种工作模式：标准 / 计划 / 自动。

和 `perm.py`（权限档）不是一回事，别混：
  · **权限档**管「写盘要不要人点一下」（readonly / ask / auto）
  · **模式**管「这一轮它该怎么干活」

    标准 standard  正常干活：直接答、直接调工具
    计划 plan      **只读**：先产出方案（计划文档），人点了「按这个来」才动手
    自动 auto      放手干：不问、不等，中途只在出错时说话

为什么计划模式要单独存在：学习计划这类活，人最怕的不是它做得慢，
是它没商量就把「每天 150 分钟改成 90 分钟」写进了本机。所以计划模式下
**任何写盘工具都拒绝执行**，只允许读 + 产出计划文档。
"""
from __future__ import annotations

from . import store

KV = "agent.mode"

MODES = {
    "standard": {
        "cn": "标准",
        "desc": "正常干活：直接答、直接动手",
        "readonly": False,
    },
    "plan": {
        "cn": "计划",
        "desc": "只读：先出方案，你点了才动手",
        "readonly": True,
    },
    "auto": {
        "cn": "自动",
        "desc": "放手干：不问、不停，错了我再说",
        "readonly": False,
    },
}
DEFAULT = "standard"


def mode():
    m = (store.kv_get(KV) or DEFAULT).strip().lower()
    return m if m in MODES else DEFAULT


def set_mode(m):
    """只有人能改（不注册成工具）。"""
    m = (m or "").strip().lower()
    if m not in MODES:
        return {"ok": False,
                "error": "没有这个模式：%s（可选 %s）"
                         % (m, " / ".join(MODES))}
    store.kv_set(KV, m)
    return {"ok": True, "mode": m, "info": MODES[m]}


def state():
    m = mode()
    return {"ok": True, "mode": m, "info": MODES[m],
            "all": [{"k": k, "cn": v["cn"], "desc": v["desc"],
                     "on": k == m} for k, v in MODES.items()]}


def is_readonly():
    """计划模式 = 只读。写盘工具在 tools.call 里据此直接拒绝。"""
    return MODES[mode()]["readonly"]


def prompt_note():
    """塞进系统提示的一句话，告诉模型现在是什么模式。"""
    m = mode()
    if m == "plan":
        return (
            "【现在是计划模式】你不能调用任何会改本机的工具（写文件、入库、改计划、"
            "标完成这类）。你只能读、只能思考，然后把方案讲清楚，等人点头。"
            "方案要具体到「先做什么、再做什么、每天多久」。"
        )
    if m == "auto":
        return (
            "【现在是自动模式】放手做，不要每一步都停下来问。"
            "只有真的需要人做决定（比如要花钱、要删东西）才停下来。"
        )
    return ""
