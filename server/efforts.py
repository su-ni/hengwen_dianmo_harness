# -*- coding: utf-8 -*-
"""推理档位（reasoning effort）按模型给。

为什么需要这张表：
  上游模型目录（WorkBuddy /v3/config、Trae 目录）只回 id/name/ctx/cap/mm/tags，
  **不含推理档位**。而每个模型能接受哪几档并不一样：
    · deepseek-v4 系（flash / pro）认 off→max 全档
    · 老一代码模型只认 low/medium/high
    · 有些小模型完全不认，传了会报 400
  所以「界面列哪几档」必须由这里决定，不能一律列七档 ——
  列了但上游拒，等于给用户一个点不动的开关（比不显示更糟）。

维护方式：新模型进来时在 MODEL_EFFORT 里加一行；没有登记的一律按 DEFAULT 处理
（off/minimal/low/medium/high，保守：不含 xhigh/max —— 那两档很多模型不支持）。
"""

# 各模型的可用档位（顺序即界面刻度顺序，从省到费）
_ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
_STD = ["off", "minimal", "low", "medium", "high"]
_MIN = ["low", "medium", "high"]

MODEL_EFFORT = {
    # DeepSeek V4 系（当前主用）
    "deepseek-v4-flash": _ALL,
    "deepseek-v4-pro": _ALL,
    "deepseek-v4.1-flash": _ALL,
    "deepseek-v4.1-pro": _ALL,
    # 旧 deepseek
    "deepseek-chat": _STD,
    "deepseek-reasoner": ["off", "low", "medium", "high"],
    # 常见通用模型（多数只认三档）
    "gpt-4o": _MIN,
    "gpt-4o-mini": _MIN,
    "claude-sonnet-4": _MIN,
    "qwen3-max": _STD,
}

# 没登记过的模型按这套走
DEFAULT = _STD

# 档位文案（前端只显示刻度名，说明文字在界面里另给；这里供 set/校验用）
WHY = {
    "off": "不思考，直接出答案。最快，适合查一个数、确认一件事。",
    "minimal": "极少思考。省 token，复杂任务会明显吃力。",
    "low": "轻量思考。适合闲聊、简单检索。",
    "medium": "默认档。该查几步就查几步，说清楚但不啰嗦。",
    "high": "深度思考。先逐条分析再下结论，适合排计划、比较取舍。",
    "xhigh": "更高强度。长链推理，慢但更稳。",
    "max": "最高档。只给确实需要长时间推理的题，很慢。",
}

LABEL = {
    "off": "Off", "minimal": "Minimal", "low": "Low", "medium": "Medium",
    "high": "High", "xhigh": "XHigh", "max": "Max",
}


def normalize(model_id):
    """把上游的 id 收敛成查表用的键：小写、去版本尾巴上的空格。"""
    k = str(model_id or "").strip().lower()
    return k


def levels_for(model_id):
    """这个模型能接受哪几档。返回 (levels, matched) —— matched 表示是否命中登记表。"""
    k = normalize(model_id)
    if k in MODEL_EFFORT:
        return list(MODEL_EFFORT[k]), True
    # 前缀匹配：deepseek-v4-flash-0710 这类带后缀的，按前缀认
    for key in sorted(MODEL_EFFORT, key=len, reverse=True):
        if k.startswith(key):
            return list(MODEL_EFFORT[key]), True
    return list(DEFAULT), False


def pick(model_id, want):
    """把用户想要的档位收敛到这个模型支持的最近一档（不想静默降级就先返回 None）。

    返回 (level, exact)。不支持的档一律退到离它最近的更低一档；
    已经是最低就取最低。exact=False 时调用方应该把这件事说出来。
    """
    levels, _ = levels_for(model_id)
    w = str(want or "").strip().lower()
    if w in levels:
        return w, True
    if w in _ALL:
        # 按全序找最近的、且在该模型支持范围内的
        i = _ALL.index(w)
        for d in range(1, len(_ALL)):
            for j in (i - d, i + d):
                if 0 <= j < len(_ALL) and _ALL[j] in levels:
                    return _ALL[j], False
    return levels[min(1, len(levels) - 1)] if len(levels) > 1 else levels[0], False
