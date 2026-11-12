# -*- coding: utf-8 -*-
"""AI 自组织侧边栏 · 后端

写一句需求 → WorkBuddy 模型生成入口（名字/顺序/理由）→ 双重过滤
（模型挑的 key 必须在白名单 + 本机真有数据）→ 落 kv，按工作区隔离。

设计约束：
1. 模型输出永远当**不可信数据**：key 白名单、label 长度/字符校验，
   解析失败保持上一版，绝不把陌生 key 送进前端路由。
2. 图标不交给模型：前端 key→IconName 常量表，防注入也防乱套。
3. 模型不可用如实标 rules，不假装 AI；不可用原因写进返回值。
4. 不新建表：配置存现有 kv，键 nav.<workspace_id>。
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from . import config, store

try:
    from . import platform_ai
except Exception:                                   # pragma: no cover
    platform_ai = None

# ---------------------------------------------------------------------------
# 候选页目录：key / 默认名 / 数据探针 / 是否常驻
# 模型只能从这个白名单里挑 key，label 由它自己编。
# ---------------------------------------------------------------------------
CATALOG: dict[str, dict[str, Any]] = {
    "home":      {"label": "课程主页", "probe": "subjects"},
    "today":     {"label": "今日",     "probe": "subjects"},
    "classroom": {"label": "课堂",     "probe": "subjects"},
    "schedule":  {"label": "课表",     "probe": "subjects"},
    "practice":  {"label": "练习",     "probe": "questions"},
    "vocab":     {"label": "背单词",   "probe": "vocab"},
    "exam":      {"label": "考场",     "probe": "exam"},
    "stats":     {"label": "统计",     "probe": "subjects"},
    "courses":   {"label": "课程库",   "probe": "subjects"},
    "shots":     {"label": "截图库",   "probe": "shots"},
    "notesAll":  {"label": "笔记",     "probe": "notes"},
    "canvas":    {"label": "画布",     "probe": "canvas"},
    "skills":    {"label": "技能中心", "probe": "skills"},
    "haloflux":  {"label": "haloflux", "probe": None},
    "agent":     {"label": "设置",     "probe": None},
}

PROVIDER = "workbuddy"
MAX_ITEMS = 8
TIMEOUT = 25
KV_PREFIX = "nav."

# 顶栏胶囊允许的 key（都是「某一门课的视图」）。只列 CATALOG 里真有的。
TAB_KEYS = {"home", "classroom", "schedule", "practice", "vocab"}


def _wid() -> str:
    return store.kv_get("ws.current") or ""


def _one(sql: str, args: tuple = ()) -> int:
    try:
        con = store.connect()
        try:
            row = con.execute(sql, args).fetchone()
            return int(row[0]) if row else 0
        finally:
            con.close()
    except Exception:
        return 0


def probes() -> dict[str, bool]:
    """一次查完所有数据探针。

    ★ 工作区隔离：题库/真题/截图/导图/笔记这些表没有 workspace_id，
      但它们是**跟着科目走的内容**。工作区没挂科目（workspace_subs=0）
      时一律按「无数据」处理 —— 否则切到空工作区，模型照样能挑出
      「真题卷 / 题库刷题」这些入口，等于数据门形同虚设（实测踩过）。
      只有 skills（本机技能目录）与工作区无关。
    """
    wid = _wid()
    has_subjects = _one("SELECT COUNT(*) FROM workspace_subs WHERE workspace_id=?", (wid,)) > 0
    if not has_subjects:
        return {"subjects": False, "questions": False, "vocab": False,
                "exam": False, "shots": False, "notes": False,
                "canvas": False, "skills": _skills_count() > 0}

    questions = (_one("SELECT COUNT(*) FROM answers")
                 + _one("SELECT COUNT(*) FROM exam_sessions")
                 + (_one("SELECT COUNT(*) FROM point_cards") if _has_table("point_cards") else 0))
    vocab = (_one("SELECT COUNT(*) FROM word_mem")
             + (_one("SELECT COUNT(*) FROM vocab_lists") if _has_table("vocab_lists") else 0))
    exam = _one("SELECT COUNT(*) FROM exam_sessions")
    return {
        "subjects": True,
        "questions": questions > 0,
        "vocab": vocab > 0,
        "exam": exam > 0,
        "shots": _one("SELECT COUNT(*) FROM shots") > 0,
        "notes": _one("SELECT COUNT(*) FROM notes") > 0,
        "canvas": _one("SELECT COUNT(*) FROM canvas_maps") > 0,
        "skills": _skills_count() > 0,
    }


def _has_table(name: str) -> bool:
    return _one("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (name,)) > 0


def _skills_count() -> int:
    """真技能目录：项目 skills/ 下的 SKILL.md 数量，不编。"""
    import os
    for d in (os.path.join(os.path.dirname(config.__file__), "..", "skills"),
              os.path.join(os.path.expanduser("~"), ".dsh", "skills")):
        try:
            p = os.path.abspath(d)
            if os.path.isdir(p):
                n = sum(1 for f in os.listdir(p)
                        if os.path.isfile(os.path.join(p, f, "SKILL.md")))
                if n:
                    return n
        except OSError:
            continue
    return 0


def _data_summary(p: dict[str, bool]) -> str:
    """给模型的真实数据摘要：让它判断相关性时有依据，不靠猜。"""
    bits = []
    if p.get("subjects"): bits.append("有课程/讲次")
    if p.get("exam"): bits.append("有真题卷和作答记录")
    if p.get("questions"): bits.append("有题库")
    if p.get("vocab"): bits.append("有词书/单词记忆数据")
    if p.get("shots"): bits.append("有截图")
    if p.get("notes"): bits.append("有笔记")
    if p.get("canvas"): bits.append("有知识导图")
    return "、".join(bits) if bits else "本机几乎是空的"


def _clean_label(s: Any, fallback: str) -> str:
    t = re.sub(r"[`*_\[\]<>{}]", "", str(s or "")).strip()
    # 只要前 8 个字，防模型写长句把图标条撑坏
    t = t[:8].strip()
    return t or fallback


def _parse(raw: str) -> dict[str, list[dict[str, str]]]:
    """从模型文本里抠出配置对象。

    新格式：{"rail":[{key,label,why}...], "tabs":[{key,label,why}...]}
      —— 两组由模型**各自独立**给出，tabs 不再从 rail 里筛。
    旧格式（数组）也认，兼容已经落库的旧配置；此时 tabs 退回从 rail 筛。
    抠不到就抛，由调用方保持上一版。
    """
    text = raw or ""
    # 优先找对象（含 rail 键）；找不到再退回数组
    m_obj = re.search(r"\{\s*\"rail\"\s*:[\s\S]*?\}\s*(?=\s*$|\s*```)", text)
    obj = None
    if m_obj:
        try:
            cand = json.loads(m_obj.group(0))
            if isinstance(cand, dict): obj = cand
        except Exception:
            obj = None
    if obj is None:
        # 去掉可能的 markdown 代码围栏后再试一次
        m2 = re.search(r"\{[\s\S]*?\}", text)
        if m2:
            try:
                cand = json.loads(m2.group(0))
                if isinstance(cand, dict) and "rail" in cand: obj = cand
            except Exception:
                obj = None

    def clean_list(v: Any) -> list[dict[str, str]]:
        if not isinstance(v, list): return []
        out = []
        for x in v:
            if not isinstance(x, dict): continue
            k = str(x.get("key") or "").strip()
            if k not in CATALOG:        # 白名单：陌生 key 直接丢
                continue
            why = re.sub(r"[`*_\[\]<>{}]", "", str(x.get("why") or "")).strip()[:40]
            out.append({"key": k,
                        "label": _clean_label(x.get("label"), CATALOG[k]["label"]),
                        "why": why})
        return out[:MAX_ITEMS]

    if obj is not None:
        rail = clean_list(obj.get("rail"))
        tabs = clean_list(obj.get("tabs"))
        if not rail: raise ValueError("模型没给有效的 rail 数组")
        # tabs 只能来自 TAB_KEYS（顶栏是「某一门课的视图」，不是全局入口）
        tabs = [x for x in tabs if x["key"] in TAB_KEYS]
        return {"rail": rail, "tabs": tabs}

    # 旧格式：纯数组
    m_arr = re.search(r"\[[\s\S]*?\]", text)
    if not m_arr:
        raise ValueError("模型没回 JSON")
    arr = json.loads(m_arr.group(0))
    if not isinstance(arr, list):
        raise ValueError("模型回的不是数组")
    rail = clean_list(arr)
    if not rail: raise ValueError("模型给的全是白名单外的 key")
    return {"rail": rail, "tabs": [x for x in rail if x["key"] in TAB_KEYS]}


def _filter(items: list[dict[str, str]], p: dict[str, bool]) -> list[dict[str, str]]:
    """双重过滤第二关：本机真有数据才显示。"""
    ok = []
    for it in items:
        probe = CATALOG[it["key"]]["probe"]
        if probe is None or p.get(probe, False):
            ok.append(it)
    # 至少留一个，不能让左栏空掉
    if not ok:
        ok = [{"key": "home", "label": CATALOG["home"]["label"], "why": ""}]
    if not any(x["key"] == "home" for x in ok):
        ok.insert(0, {"key": "home", "label": CATALOG["home"]["label"], "why": ""})
    return ok[:MAX_ITEMS]


def _filter_tabs(items: list[dict[str, str]], p: dict[str, bool]) -> list[dict[str, str]]:
    """顶栏单独一组：各自过数据门，但不强制插 home（rail 已经兜底了）。"""
    ok = []
    for it in items:
        probe = CATALOG[it["key"]]["probe"]
        if probe is None or p.get(probe, False):
            ok.append(it)
    return ok[:5]


def _default() -> dict[str, Any]:
    """没生成过配置时的全量兜底 —— 但**也要过数据门**。

    新建的空工作区没有 nav.<wid> 记录，如果直接回 15 项全量，
    就会出现「一个科目都没有，左栏却摆着考场/背单词/截图库」的假象，
    跟「有内容才显示入口」直接矛盾（实测踩过）。
    """
    p = probes()
    items = _filter([{"key": k, "label": v["label"], "why": ""}
                     for k, v in CATALOG.items()], p)
    tabs = _filter_tabs([{"key": k, "label": CATALOG[k]["label"], "why": ""}
                         for k in ("home", "classroom", "schedule", "practice")
                         if k in CATALOG], p)
    return {
        "ok": True, "items": items, "tabs": tabs,
        "source": "default", "model": "", "reason": "", "at": int(time.time()),
    }


def current() -> dict[str, Any]:
    try:
        raw = store.kv_get(KV_PREFIX + _wid())
        if raw:
            d = json.loads(raw)
            if isinstance(d, dict) and d.get("items"):
                return {"ok": True, **d}
    except Exception:
        pass
    return _default()


def _rules(text: str, p: dict[str, bool], reason: str) -> dict[str, Any]:
    """模型不可用时的回落：关键词 → 候选页。如实标 source='rules'。"""
    t = text or ""
    picked: list[str] = []
    rules = [
        (r"背单词|词汇|单词|四六级|46级|英语", ["vocab", "practice"]),
        (r"真题|试卷|刷题|考场", ["exam", "practice"]),
        (r"排课|课表|计划|每天|备考", ["schedule", "today"]),
        (r"课|讲次|视频|上课", ["classroom", "home"]),
        (r"统计|进度|复习", ["stats"]),
        (r"笔记|导图", ["notesAll", "canvas"]),
    ]
    for re_, keys in rules:
        if re.search(re_, t):
            for k in keys:
                if k not in picked: picked.append(k)
    items = _filter([{"key": k, "label": CATALOG[k]["label"], "why": ""}
                     for k in picked] or
                    [{"key": "home", "label": CATALOG["home"]["label"], "why": ""}], p)
    # 规则回落也单独给一组顶栏：按需求关键词挑，不从 items 里筛
    tab_pick: list[str] = []
    if re.search(r"排课|课表|计划|备考|每天", t): tab_pick.append("schedule")
    if re.search(r"背单词|词汇|单词", t): tab_pick.append("vocab")
    if re.search(r"刷题|练习|真题", t): tab_pick.append("practice")
    if re.search(r"课|讲次|视频", t): tab_pick.append("classroom")
    if not tab_pick: tab_pick = ["home", "classroom", "schedule", "practice"]
    tabs = _filter_tabs([{"key": k, "label": CATALOG[k]["label"], "why": ""}
                         for k in tab_pick if k in CATALOG], p)
    return {
        "ok": True, "items": items, "tabs": tabs,
        "source": "rules", "model": "", "reason": reason, "at": int(time.time()),
    }


def generate(text: str) -> dict[str, Any]:
    """主入口。返回 NavConfig；任何失败都不白屏、都不假装 AI。"""
    p = probes()
    txt = (text or "").strip()[:500]

    if not platform_ai:
        return _rules(txt, p, "platform_ai 模块没加载")
    st = platform_ai.status(PROVIDER)
    if not st.get("usable"):
        return _rules(txt, p, str(st.get("why") or "WorkBuddy 不可用"))

    keys = ", ".join(CATALOG.keys())
    tab_keys = ", ".join(sorted(TAB_KEYS & set(CATALOG.keys())))
    sys_p = (
        "你是工作区侧边栏规划器。用户给你一句学习需求，和两组允许的页面 key。\n"
        "只输出一个 JSON 对象，格式严格如下，不要解释、不要 Markdown、不要输出对象以外的任何字符：\n"
        '{"rail":[{"key":"exam","label":"真题","why":"理由"}],'
        '"tabs":[{"key":"home","label":"首页","why":"理由"}]}\n'
        "规则：\n"
        "1. rail = 左侧图标条入口，最多 8 个，只挑跟这句需求最相关的，按重要程度排序。\n"
        "2. tabs = 顶栏「这一门课的视图」胶囊，**单独给一组**，最多 5 个；"
        "可以跟 rail 不同（比如 rail 放真题卷，tabs 放课程/计划）。\n"
        "3. label 你自己起（≤8 字、中文、别照抄默认名）；why 一句话说清为什么。\n"
        "4. rail 的 key 只能来自：" + keys + "\n"
        "5. tabs 的 key 只能来自：" + tab_keys + "\n"
        "6. 只挑跟需求相关的，宁可少给不要凑数。"
    )
    usr = "本机数据：" + _data_summary(p) + "\n用户的需求：" + (txt or "（没写，按常规备考）")

    try:
        r = platform_ai.chat(PROVIDER, sys_p, usr,
                             model=getattr(config, "WB_MODEL", None),
                             max_tokens=600, timeout=TIMEOUT)
    except Exception as e:
        return _rules(txt, p, "模型调用失败：%s" % str(e)[:120])
    if not (r or {}).get("ok"):
        return _rules(txt, p, str((r or {}).get("reason") or "模型没回成功"))

    try:
        parsed = _parse((r or {}).get("text") or "")
    except Exception as e:
        # 解析失败：保持上一版，不覆盖成错的
        prev = current()
        prev["reason"] = "模型回的 JSON 没解析出来（%s），沿用上一版" % str(e)[:80]
        return prev

    items = _filter(parsed["rail"], p)
    # tabs 是模型单独给的一组，各自再过一次数据门
    tabs = _filter_tabs(parsed["tabs"], p)
    conf = {
        "ok": True, "items": items, "tabs": tabs,
        "source": "ai", "model": str((r or {}).get("model") or PROVIDER),
        "reason": "", "at": int(time.time()),
    }
    try:
        store.kv_set(KV_PREFIX + _wid(), json.dumps(conf, ensure_ascii=False))
    except Exception:
        pass
    return conf
