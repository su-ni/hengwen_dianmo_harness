# -*- coding: utf-8 -*-
"""研学台 · 工作区（最高层实体）。

为什么要有这一层：
  以前整个系统只有「一个考生 + 一份计划」：data/plan.json 一个 exam_date、
  subjects[] 一个数组。想同时备考专升本、顺手学摄影、再跟一门考研的课，
  三件事会挤在同一张课表、同一个 exam_date、同一个进度上，互相污染。
  工作区把「一次学习目标」隔成独立单元：科目、计划、模块、会话各归各的。

数据落在哪（D17）：
  共享的东西（题库 / 词库 / 课程视频）仍全局一份，工作区只引用，不复制。
  工作区自己的东西（计划文档、模块、附件、可视化）落 workspaces/<id>/ 目录。
  会话、进度、作答这些「有记录的」仍走同一个 SQLite，用 workspace_id 区分。

迁移（D18）：
  老库没有 workspaces 行 → 自动建一个「我的学习」工作区，把现有科目与
  plan.json 挂进去，一条记录都不丢。迁移是幂等的：跑两遍不会建两个。
"""
import json
import os
import re
import sqlite3
import time

from . import config
from . import silent as _silent

# 工作区模块：勾了才在左栏与页面里出现。模块不认识时按「开」处理，
# 别因为前端加了新模块名就把老工作区锁死。
MODULES = ("courses", "classroom", "schedule", "practice", "vocab", "notes",
           "exam", "stats", "writing", "canvas", "shots")

_DDL = """
CREATE TABLE IF NOT EXISTS workspaces(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'study',   -- study / exam / hobby
  icon TEXT,
  exam_date TEXT,
  minutes_per_day INTEGER DEFAULT 150,
  vocab_minutes INTEGER DEFAULT 20,
  modules TEXT,                          -- JSON 数组；NULL = 全部模块
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_ws_arch ON workspaces(archived, created_at);

CREATE TABLE IF NOT EXISTS workspace_subs(
  workspace_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  lessons_per_day REAL DEFAULT 1,
  ord INTEGER DEFAULT 0,
  PRIMARY KEY(workspace_id, subject_id)
);

CREATE TABLE IF NOT EXISTS plan_docs(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,                    -- 相对工作区目录
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft / approved / done / dropped
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_pd_ws ON plan_docs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS modules(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  schema TEXT,                           -- 声明式模块：字段/布局/工具清单
  origin TEXT NOT NULL DEFAULT 'user',   -- user / ai
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mod ON modules(workspace_id, key);
"""


# ------------------------------------------------------------------ 目录
def ws_root():
    return os.path.join(config.APP_DATA_DIR, "workspaces")


def ws_dir(wid):
    return os.path.join(ws_root(), wid)


def ws_sub(*parts):
    """工作区下的子目录路径（自动建）。"""
    p = os.path.join(ws_root(), *parts)
    os.makedirs(p, exist_ok=True)
    return p


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _slug(name):
    """工作区 id 只用 ASCII：中文名转成哈希后缀，目录名与 URL 都不会出编码问题。"""
    import hashlib
    raw = (name or "").strip()
    ascii_part = re.sub(r"[^0-9a-zA-Z]+", "-", raw).strip("-").lower()
    if ascii_part and not re.search(r"[\u4e00-\u9fff]", raw):
        return ascii_part[:24]
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:6]
    return (ascii_part[:16] + "-" if ascii_part else "") + "ws" + h


def _newid(con, name):
    base = "w-" + _slug(name)
    if not con.execute("SELECT 1 FROM workspaces WHERE id=?", (base,)).fetchone():
        return base
    i = 2
    while con.execute("SELECT 1 FROM workspaces WHERE id=?", ("%s-%d" % (base, i),)).fetchone():
        i += 1
    return "%s-%d" % (base, i)


def _cols(con, table):
    try:
        return {r[1] for r in con.execute("PRAGMA table_info(%s)" % table).fetchall()}
    except sqlite3.Error:
        return set()


def init(con):
    """建表 + 幂等迁移。store.init 里调一次即可。"""
    con.executescript(_DDL)
    # sessions 补 workspace_id（NULL = 全局会话）
    scols = _cols(con, "sessions")
    if scols and "workspace_id" not in scols:
        try:
            con.execute("ALTER TABLE sessions ADD COLUMN workspace_id TEXT")
        except sqlite3.Error as _e:
            _silent.log_squash(__name__, _e)
    migrate(con)


# ------------------------------------------------------------------ 解析
def _mods(row):
    raw = row["modules"] if row["modules"] else None
    if not raw:
        return list(MODULES)
    try:
        v = json.loads(raw)
        return [m for m in MODULES if m in v] or list(MODULES)
    except Exception:
        return list(MODULES)


def one(con, wid):
    if not wid:
        return None
    row = con.execute("SELECT * FROM workspaces WHERE id=?", (wid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["modules"] = _mods(row)
    subs = con.execute(
        "SELECT subject_id, lessons_per_day, ord FROM workspace_subs "
        "WHERE workspace_id=? ORDER BY ord, subject_id", (wid,)).fetchall()
    d["subjects"] = [dict(s) for s in subs]
    return d


def all_(con, include_archived=False):
    q = "SELECT * FROM workspaces" + ("" if include_archived else " WHERE archived=0")
    q += " ORDER BY archived, created_at DESC"
    out = []
    for row in con.execute(q).fetchall():
        d = dict(row)
        d["modules"] = _mods(row)
        d["subjects"] = [dict(s) for s in con.execute(
            "SELECT subject_id, lessons_per_day, ord FROM workspace_subs "
            "WHERE workspace_id=? ORDER BY ord, subject_id", (d["id"],)).fetchall()]
        out.append(d)
    return out


def current(con):
    """当前工作区：kv 里记的优先，没有就取第一个；一个都没有返回 None。"""
    from . import store
    wid = store.kv_get("ws.current")
    if wid:
        row = con.execute("SELECT 1 FROM workspaces WHERE id=? AND archived=0", (wid,)).fetchone()
        if row:
            return one(con, wid)
    rows = all_(con)
    return rows[0] if rows else None


def set_current(con, wid):
    from . import store
    if not con.execute("SELECT 1 FROM workspaces WHERE id=?", (wid,)).fetchone():
        return False
    store.kv_set("ws.current", wid)
    return True


# ------------------------------------------------------------------ 写
def create(con, name, kind="study", exam_date=None, minutes_per_day=None,
           vocab_minutes=None, icon=None, subjects=None, modules=None, wid=None):
    name = (name or "").strip() or "未命名工作区"
    wid = wid or _newid(con, name)
    now = _now()
    con.execute(
        "INSERT INTO workspaces(id,name,kind,icon,exam_date,minutes_per_day,"
        "vocab_minutes,modules,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (wid, name, kind or "study", icon,
         exam_date,
         int(minutes_per_day) if minutes_per_day else None,
         int(vocab_minutes) if vocab_minutes else None,
         json.dumps([m for m in (modules or []) if m in MODULES], ensure_ascii=False)
         if modules is not None else None,
         now, now))
    if subjects:
        for i, s in enumerate(subjects):
            # 允许传 str 或 {"id":..,"lessons_per_day":..}
            if isinstance(s, dict):
                sid, lpd = s.get("id") or s.get("subject"), s.get("lessons_per_day", 1)
            else:
                sid, lpd = s, 1
            if sid:
                con.execute(
                    "INSERT OR REPLACE INTO workspace_subs(workspace_id,subject_id,"
                    "lessons_per_day,ord) VALUES(?,?,?,?)",
                    (wid, sid, float(lpd or 1), i))
    try:
        os.makedirs(ws_dir(wid), exist_ok=True)
        os.makedirs(os.path.join(ws_dir(wid), "plans"), exist_ok=True)
        os.makedirs(os.path.join(ws_dir(wid), "modules"), exist_ok=True)
        os.makedirs(os.path.join(ws_dir(wid), "uploads"), exist_ok=True)
    except OSError as _e:
        _silent.log_squash(__name__, _e)
    con.commit()
    return one(con, wid)


_PATCH = {"name", "kind", "icon", "exam_date", "minutes_per_day",
          "vocab_minutes", "archived"}


def update(con, wid, **kw):
    sets, vals = [], []
    for k, v in kw.items():
        if k not in _PATCH:
            continue
        sets.append("%s=?" % k)
        vals.append(v)
    if "modules" in kw:
        sets.append("modules=?")
        vals.append(json.dumps([m for m in (kw["modules"] or []) if m in MODULES],
                               ensure_ascii=False))
    if not sets:
        return one(con, wid)
    sets.append("updated_at=?")
    vals.append(_now())
    vals.append(wid)
    con.execute("UPDATE workspaces SET " + ", ".join(sets) + " WHERE id=?", vals)
    con.commit()
    return one(con, wid)


def delete(con, wid, drop_files=False, purge=False):
    """删工作区。

    drop_files：是否删磁盘目录（默认不删，误删不可逆）
    purge：是否**连同业务数据一起删**（会话/作答/笔记/画布/截图/进度/事件）。
           默认 False = 只删登记，数据留着但会变成「未归属」，
           界面上能找回来。True 才会真删。
    """
    if purge:
        for t in ("sessions", "answers", "word_mem", "notes", "canvas_maps",
                  "shots", "lesson_progress", "events"):
            try:
                con.execute("DELETE FROM %s WHERE workspace_id=?" % t, (wid,))
            except Exception:
                pass          # 老库可能没有这一列，跳过不阻断删除
        try:
            con.execute("DELETE FROM session_events WHERE session_id NOT IN"
                        " (SELECT id FROM sessions)")
        except Exception as _e:
            _silent.log_squash(__name__, _e)

    con.execute("DELETE FROM workspace_subs WHERE workspace_id=?", (wid,))
    con.execute("DELETE FROM modules WHERE workspace_id=?", (wid,))
    con.execute("DELETE FROM plan_docs WHERE workspace_id=?", (wid,))
    con.execute("DELETE FROM workspaces WHERE id=?", (wid,))
    con.commit()
    if drop_files:
        import shutil
        try:
            shutil.rmtree(ws_dir(wid))
        except OSError as _e:
            _silent.log_squash(__name__, _e)
    return True


def set_subjects(con, wid, subjects):
    con.execute("DELETE FROM workspace_subs WHERE workspace_id=?", (wid,))
    for i, s in enumerate(subjects or []):
        if isinstance(s, dict):
            sid, lpd = s.get("id") or s.get("subject"), s.get("lessons_per_day", 1)
        else:
            sid, lpd = s, 1
        if not sid:
            continue
        con.execute(
            "INSERT OR REPLACE INTO workspace_subs(workspace_id,subject_id,"
            "lessons_per_day,ord) VALUES(?,?,?,?)",
            (wid, sid, float(lpd or 1), i))
    con.commit()
    return one(con, wid)


# ------------------------------------------------------------------ 迁移
def _read_plan_json():
    p = getattr(config, "APP_DATA_DIR", None)
    if not p:
        return {}
    f = os.path.join(p, "plan.json")
    try:
        with open(f, "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except Exception:
        return {}


def migrate(con):
    """老库第一次跑：把「一个考生一份计划」升成「一个工作区」。

    判据只有一条：workspaces 表是空的，而本机已经有真实数据（plan.json 有
    exam_date / per_subject，或 subjects 非空）。两个条件都满足才建，
    用户主动删光工作区后不会每次启动都复活一个。
    幂等：已经建过（workspaces 非空）就直接返回。
    """
    n = con.execute("SELECT COUNT(*) c FROM workspaces").fetchone()[0]
    if n:
        return None
    plan = _read_plan_json()
    if not plan:
        return None                      # 全新安装：留给引导去建，不塞假工作区

    # 老 plan.json 的科目与每日节数
    subs = []
    for x in plan.get("per_subject") or []:
        sid = x.get("subject")
        if sid:
            subs.append({"id": sid, "lessons_per_day": x.get("lessons_per_day", 1)})
    if not subs:
        # 没有 per_subject 但有 exam_date：按本机现有科目挂上
        try:
            from . import datahub
            subs = [{"id": s.get("id"), "lessons_per_day": 1}
                    for s in (datahub.subjects() or []) if s.get("id")]
        except Exception:
            subs = []

    ws = create(con, "我的学习", kind="study",
                wid="w-default",
                exam_date=plan.get("exam_date"),
                minutes_per_day=plan.get("minutes_per_day"),
                vocab_minutes=plan.get("vocab_minutes"),
                subjects=subs)
    # 老 plan.json 原样留档（可回滚），并记在 kv 里说明它是从哪儿来的
    try:
        from . import store
        store.kv_set("ws.migrated_from_plan_json", _now())
        store.kv_set("ws.current", ws["id"])
    except Exception as _e:
        _silent.log_squash(__name__, _e)
    return ws


# ------------------------------------------------------------------ 计划文档
def plan_doc_dir(wid):
    d = os.path.join(ws_dir(wid), "plans")
    os.makedirs(d, exist_ok=True)
    return d


def plan_doc_add(con, wid, title, body, status="draft"):
    import uuid
    pid = "p-" + uuid.uuid4().hex[:10]
    safe = _slug(title)[:40] or "plan"
    fname = "%s-%s.md" % (time.strftime("%Y%m%d-%H%M%S"), safe)
    full = os.path.join(plan_doc_dir(wid), fname)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(body or "")
    con.execute("INSERT INTO plan_docs(id,workspace_id,path,title,status,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (pid, wid, fname, title, status, _now(), _now()))
    con.commit()
    return {"id": pid, "path": fname, "abs": full, "title": title, "status": status}


def plan_docs(con, wid):
    return [dict(r) for r in con.execute(
        "SELECT * FROM plan_docs WHERE workspace_id=? ORDER BY created_at DESC",
        (wid,)).fetchall()]


def plan_doc_read(con, pid):
    row = con.execute("SELECT * FROM plan_docs WHERE id=?", (pid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        with open(os.path.join(plan_doc_dir(d["workspace_id"]), d["path"]),
                  "r", encoding="utf-8") as fh:
            d["body"] = fh.read()
    except OSError:
        d["body"] = ""
    return d


def plan_doc_set_status(con, pid, status):
    con.execute("UPDATE plan_docs SET status=?, updated_at=? WHERE id=?",
                (status, _now(), pid))
    con.commit()
    return plan_doc_read(con, pid)


# ------------------------------------------------------------------ 模块
def modules_of(con, wid):
    return [dict(r) for r in con.execute(
        "SELECT * FROM modules WHERE workspace_id=? ORDER BY created_at", (wid,)).fetchall()]


def module_upsert(con, wid, key, name=None, enabled=True, schema=None, origin="user"):
    import uuid
    row = con.execute("SELECT id FROM modules WHERE workspace_id=? AND key=?",
                      (wid, key)).fetchone()
    mid = row["id"] if row else ("m-" + uuid.uuid4().hex[:10])
    sch = json.dumps(schema, ensure_ascii=False) if schema is not None else None
    if row:
        con.execute("UPDATE modules SET name=?, enabled=?, schema=?, origin=? WHERE id=?",
                    (name, 1 if enabled else 0, sch, origin, mid))
    else:
        con.execute("INSERT INTO modules(id,workspace_id,key,name,enabled,schema,"
                    "origin,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (mid, wid, key, name, 1 if enabled else 0, sch, origin, _now()))
    con.commit()
    return {"id": mid, "key": key, "name": name, "enabled": bool(enabled), "origin": origin}
