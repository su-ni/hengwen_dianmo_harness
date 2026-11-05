# -*- coding: utf-8 -*-
"""气泡通知（第 7 章 D18–D22）。

**为什么状态必须放在后端**：
气泡的核心要求是「跨工作区」——在 A 里发起的任务，切到 B 还看得到状态。
前端 state 一切页就没了，所以这份状态只能存服务端。

**为什么不做成浮窗**（D20 的设计约束）：
它是「瞄一眼就知道进展」的东西，不是通知中心。
所以只存一行状态 + 一个级别，真要回答时才展开成小卡片（D21/D22）。

分级（D22）：
    light  状态点：运行中 / 调了 N 个工具 / 完成 —— 只亮一下，不打断
    heavy  需要你回答 —— 展开成小卡片，可直接输入（D21）

生命周期：一次 turn 开始 → 登记 running；工具调用 → 计数；结束 → done；
        需要人答 → heavy；人答完 / 关掉 → 消失。
"""
from __future__ import annotations

import time

from . import store
from . import silent as _silent

MAX_KEEP = 20          # 最多留几条，防止堆成通知中心


def _now():
    return time.time()


def ensure_schema(con):
    """一张小表：谁在跑、跑到哪、要不要人答。"""
    con.execute("""
    CREATE TABLE IF NOT EXISTS bubbles(
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      session_id TEXT,
      title TEXT,
      state TEXT DEFAULT 'running',   -- running / done / ask / error
      level TEXT DEFAULT 'light',     -- light / heavy
      tools INTEGER DEFAULT 0,
      last_tool TEXT,
      question TEXT,                  -- 需要人答时那句问话
      ask_json TEXT,                  -- 结构化的提问（给多选面板用）
      ts REAL,
      updated REAL
    )""")
    con.commit()


def _new_id():
    return "b-%d" % int(_now() * 1000)


def start(workspace_id=None, session_id=None, title=None):
    """一轮开始：登记一条 running 气泡。"""
    con = store.connect()
    try:
        ensure_schema(con)
        bid = _new_id()
        con.execute(
            "INSERT INTO bubbles(id,workspace_id,session_id,title,state,level,"
            "tools,ts,updated) VALUES(?,?,?,?,'running','light',0,?,?)",
            (bid, workspace_id, session_id, (title or "正在处理")[:60], _now(), _now()))
        # 只留最近若干条，老的自动清
        con.execute("DELETE FROM bubbles WHERE id NOT IN "
                    "(SELECT id FROM bubbles ORDER BY updated DESC LIMIT ?)", (MAX_KEEP,))
        con.commit()
        return bid
    finally:
        con.close()


def tool(bid, name=None):
    """调了一个工具：计数 + 记名字。"""
    if not bid:
        return
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute("UPDATE bubbles SET tools=tools+1, last_tool=?, updated=? WHERE id=?",
                    ((name or "")[:40], _now(), bid))
        con.commit()
    finally:
        con.close()


def finish(bid, ok=True, title=None, error=None):
    """这一轮完了。"""
    if not bid:
        return
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute(
            "UPDATE bubbles SET state=?, level='light', updated=?, title=COALESCE(?,title) "
            "WHERE id=?",
            ("done" if ok else "error", _now(), (title or "")[:60] or None, bid))
        if error:
            con.execute("UPDATE bubbles SET last_tool=?, updated=? WHERE id=?",
                        (("失败：" + str(error))[:60], _now(), bid))
        con.commit()
    finally:
        con.close()


def need_answer(bid, question, ask=None):
    """它停下来等人回答了（D21/D22 的重打扰）。"""
    if not bid:
        return
    import json
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute(
            "UPDATE bubbles SET state='ask', level='heavy', question=?, ask_json=?, updated=? "
            "WHERE id=?",
            ((question or "")[:200], json.dumps(ask, ensure_ascii=False) if ask else None,
             _now(), bid))
        con.commit()
    finally:
        con.close()


def dismiss(bid):
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute("DELETE FROM bubbles WHERE id=?", (bid,))
        con.commit()
        return {"ok": True}
    finally:
        con.close()


def dismiss_all(workspace_id=None):
    con = store.connect()
    try:
        ensure_schema(con)
        if workspace_id is None:
            con.execute("DELETE FROM bubbles")
        else:
            con.execute("DELETE FROM bubbles WHERE workspace_id IS ?", (workspace_id,))
        con.commit()
        return {"ok": True}
    finally:
        con.close()


def list_(workspace_id=None, include_other=True):
    """当前要显示的气泡。

    include_other=True 就是「跨工作区」：别的区在跑也让你看见（D18）。
    每条带上它属于哪个工作区，界面点击可跳回去。
    """
    import json
    con = store.connect()
    try:
        ensure_schema(con)
        if include_other:
            rows = con.execute(
                "SELECT * FROM bubbles ORDER BY updated DESC LIMIT ?", (MAX_KEEP,)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM bubbles WHERE workspace_id IS ? ORDER BY updated DESC LIMIT ?",
                (workspace_id, MAX_KEEP)).fetchall()
        # 工作区名一次查完 —— 别在循环里查库
        names = {}
        try:
            from . import workspaces as _wsm
            for w in _wsm.all_(con, include_archived=True):
                names[w["id"]] = w["name"]
        except Exception as _e:
            _silent.log_squash(__name__, _e)

        out = []
        for r in rows:
            d = dict(r)
            # 只显示「还该被看见的」：running / ask / 刚完成的（30 秒内）
            age = _now() - (d.get("updated") or 0)
            if d["state"] == "done" and age > 30:
                continue
            if d.get("ask_json"):
                try:
                    d["ask"] = json.loads(d["ask_json"])
                except Exception:
                    d["ask"] = None
            d.pop("ask_json", None)
            # 带上工作区名字，界面上要能说清「这是哪个区的」
            d["ws_name"] = names.get(d.get("workspace_id"))
            out.append(d)
        return out
    finally:
        con.close()


def cleanup():
    """超过 10 分钟的死气泡清掉（进程重启后 running 会永远挂着）。"""
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute("DELETE FROM bubbles WHERE updated < ?", (_now() - 600,))
        con.commit()
    finally:
        con.close()
