# -*- coding: utf-8 -*-
"""会话收尾：起个名字 + 给四条下一步建议。

**现实约束**（踩过的坑）：当前接入的模型是强制推理型的，
无论把 max_tokens 调大还是把 effort 设成 off，它都会把预算全花在思考上，
正文一个字都吐不出来（实测 600 / 800 / 1200 / 1800 预算，思考全吃满）。

所以分两层：
  1. 先试模型（能出 JSON 就用它，质量更好）
  2. 出不来就**用规则兜底** —— 名字从首句截，建议从本机真实情况里挑。
     这不是编：清到期词、看错题、接着学下一讲，全都是当前真有的事。

只做模型：出不来就是空的，用户什么也看不到，等于没做。
只做规则：模型哪天能出正文了，质量明显更好，路留着。
"""
from __future__ import annotations

import json
import re

from . import store
from . import silent as _silent


def _clip(s, n):
    s = str(s or "").strip().replace("\n", " ")
    s = re.sub(r"\s+", " ", s)
    return s[:n]


# ---------------------------------------------------------------- 规则兜底

def _title_by_rule(user_text):
    """从用户第一句话里抠一个像标题的短语。"""
    t = _clip(user_text, 60)
    if not t:
        return ""
    t = re.sub(r"^(帮我|请|麻烦|能不能|可以|我想|我要|我想问|请问)+", "", t)
    t = re.sub(r"[？?。！!，,、].*$", "", t).strip()
    return t[:14]


def _suggest_by_rule(reply_text):
    """从「本机真实情况」里挑四条下一步，不编造。"""
    out = []
    try:
        from . import datahub
        b = datahub.bootstrap()
        k = b.get("kpi") or {}
        due = int(((b.get("vocab") or {}).get("mem_counts") or {}).get("due_today") or 0)
        if due > 0:
            out.append("清掉今天到期的 %d 个词" % due)
        answered = int(k.get("answered") or 0)
        if answered > 0:
            out.append("看看错题都错在哪")
        remain = 0
        for s in (b.get("subjects") or []):
            remain += max(0, int(s.get("lessons_total") or 0) - int(s.get("lessons_done") or 0))
        if remain > 0:
            out.append("接着学下一讲")
        if int(k.get("exam_papers") or 0) > 0:
            out.append("做一套真题卷试试")
    except Exception as _e:
        _silent.log_squash(__name__, _e)

    first = _clip(reply_text, 80)
    if first and len(out) < 4:
        m = re.match(r"^[^，。；,:]{2,18}", first)
        if m:
            cand = "再详细说说「%s」" % m.group(0)
            if cand not in out:
                out.append(cand)

    for x in ("把这一周的计划排出来", "按我的弱项出几道题",
              "总结一下我这周学了什么", "帮我找一门更合适的课"):
        if len(out) >= 4:
            break
        if x not in out:
            out.append(x)
    return out[:4]


# ---------------------------------------------------------------- 模型路径

def _parse_json_block(txt):
    if not txt:
        return None
    s = str(txt)
    m = re.search(r"```(?:json)?\s*(.+?)```", s, re.S)
    if m:
        s = m.group(1)
    else:
        i, j = s.find("{"), s.rfind("}")
        if i >= 0 and j > i:
            s = s[i:j + 1]
    try:
        v = json.loads(s)
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _sys_prompt():
    return (
        "你在给一段学习对话做收尾。只输出一个 JSON 对象，不要任何解释。\n"
        '格式：{"title":"不超过12个字的标题","suggest":["建议1","建议2","建议3","建议4"]}\n'
        "· title：说清这段在聊什么\n"
        "· suggest：4 条下一步能直接执行的短句，每条不超过 16 个字\n"
    )


def finish_turn_text(user_text, reply_text):
    """返回 ({title, suggest}, source)。source: model / rule / none。"""
    u = _clip(user_text, 300)
    a = _clip(reply_text, 800)

    title, sug = "", []
    try:
        from . import platform_ai, model_router
        prov = model_router.current()
        if prov:
            r = platform_ai.chat(
                prov, _sys_prompt(),
                "用户说：%s\n\n助手回答：%s\n\n直接输出 JSON。" % (u or "（空）", a or "（空）"),
                temperature=0.2, max_tokens=700, timeout=40,
            )
            if r.get("ok"):
                v = _parse_json_block(r.get("text") or "")
                if v:
                    title = _clip(v.get("title") or "", 24)
                    raw = v.get("suggest") or []
                    if isinstance(raw, str):
                        raw = [raw]
                    for x in raw:
                        t = _clip(x, 40)
                        if t and t not in sug:
                            sug.append(t)
                        if len(sug) >= 4:
                            break
    except Exception as _e:
        _silent.log_squash(__name__, _e)

    if title and len(sug) >= 4:
        return {"title": title, "suggest": sug}, "model"

    if not title:
        title = _title_by_rule(u)
    if len(sug) < 4:
        for x in _suggest_by_rule(a):
            if x not in sug:
                sug.append(x)
            if len(sug) >= 4:
                break
    src = "rule" if (title or sug) else "none"
    return {"title": title, "suggest": sug[:4]}, src


def apply_title(sid, title):
    """只给还没有标题的会话写标题 —— 人自己改过的不覆盖。"""
    if not sid or not title:
        return False
    try:
        s = store.session_get(sid)
        if not s:
            return False
        if (s.get("title") or "").strip():
            return False
        store.session_rename(sid, title)
        return True
    except Exception:
        return False
