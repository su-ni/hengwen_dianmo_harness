# -*- coding: utf-8 -*-
"""记忆系统（对齐第 9 章 D28–D32）。

设计依据（文档 9.1 调研结论）：
  · 借 **Hindsight** 的「写时抽取事实 + 读时多路检索 + 重排」
  · 用 **Cognee** 的「纯本地 SQLite」思路，不引外部服务
  · 借 **Zep/Graphiti** 的「事实带有效期」——学习进度天然有时效

表结构严格按文档 2.2：
    memories(id, workspace_id, kind, content, entities, embedding,
             source, created_at, valid_from, valid_to)
    memory_links(from_id, to_id, relation)      -- 星图的边

记忆类型（文档 9.2 五种，不是我之前拍的三类）：
    pref      偏好      「喜欢先看例子再看定义」
    fact      事实      「C 语言的指针在 10-25 学完了」
    difficulty 困难点   「递归总是绕不出来」
    goal      目标      「2027-03-15 专升本考试」
    change    计划变更  「把每天 150 分钟改成 120」
"""
from __future__ import annotations

import json
import math
import re
import time

from . import store
from . import silent as _silent

MAX_CONTENT = 400          # 一条记忆的上限：超过就不是「一句能读完的事」
# insight（洞察）是早期测试写进来、一直没归类的第六种。
# 这一版把它**正式收编**：它在语义上确实独立于其他五类 ——
# 「三角函数和从句是弱项」是模型/人从数据里**归纳**出来的判断，
# 不是用户原话（difficulty 是原话），也不是单纯的事实陈述。
# 收编而不是删掉的理由：这类"归纳"是记忆系统最该留住的东西 ——
# 它比一条原始事实更有用，但前提是它能被单独检索到。
KINDS = ("pref", "fact", "difficulty", "goal", "change", "insight")
KIND_CN = {
    "pref": "偏好", "fact": "事实", "difficulty": "困难点",
    "goal": "目标", "change": "计划变更",
    # 历史数据里出现过、但没在 KINDS 里的一类。留着名字，
    # 免得界面上出现一个英文的「insight」孤零零挂在中文里。
    "insight": "洞察",
}
RELATIONS = ("related", "caused_by", "contradicts", "refines", "part_of")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def ensure_schema(con):
    """建表 + 补列。老表（我上一版建的）要平滑升级，不丢数据。"""
    con.execute("""
    CREATE TABLE IF NOT EXISTS memories(
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      kind TEXT DEFAULT 'fact',
      content TEXT,
      entities TEXT,          -- JSON 数组：里面提到的人/科目/知识点
      embedding BLOB,         -- 预留：本机小向量，暂不写
      source TEXT DEFAULT 'user',
      weight REAL DEFAULT 0.6,
      hits INTEGER DEFAULT 0,
      last_hit TEXT,
      created_at TEXT,
      valid_from TEXT,
      valid_to TEXT,
      updated_at TEXT
    )""")
    con.execute("""
    CREATE TABLE IF NOT EXISTS memory_links(
      from_id TEXT NOT NULL,
      to_id   TEXT NOT NULL,
      relation TEXT DEFAULT 'related',
      note TEXT,
      created_at TEXT,
      PRIMARY KEY(from_id, to_id, relation)
    )""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_mem_ws ON memories(workspace_id)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_link_from ON memory_links(from_id)")

    # 从上一版（text 字段）平滑迁移到 content
    cols = {r[1] for r in con.execute("PRAGMA table_info(memories)").fetchall()}
    if "content" not in cols:
        con.execute("ALTER TABLE memories ADD COLUMN content TEXT")
    if "text" in cols:
        con.execute("UPDATE memories SET content=text "
                    "WHERE (content IS NULL OR content='') AND text IS NOT NULL")
    for c, ddl in (("entities", "TEXT"), ("embedding", "BLOB"),
                   ("valid_from", "TEXT"), ("valid_to", "TEXT"),
                   ("weight", "REAL DEFAULT 0.6"), ("hits", "INTEGER DEFAULT 0"),
                   ("last_hit", "TEXT"), ("updated_at", "TEXT"),
                   ("source", "TEXT DEFAULT 'user'")):
        if c not in cols:
            con.execute("ALTER TABLE memories ADD COLUMN %s %s" % (c, ddl))
    # 上一版把来源存在 src 里，新代码统一用 source
    if "src" in cols and "source" not in cols:
        con.execute("UPDATE memories SET source=src WHERE source IS NULL")

    # 上一版的 text 列带 NOT NULL 约束，而新代码只写 content ——
    # 不重建表的话插入会撞在 text 上。重建一次，把数据搬过去。
    if "text" in cols:
        con.execute("ALTER TABLE memories RENAME TO memories_old")
        con.execute("""
        CREATE TABLE memories(
          id TEXT PRIMARY KEY, workspace_id TEXT, kind TEXT DEFAULT 'fact',
          content TEXT, entities TEXT, embedding BLOB,
          source TEXT DEFAULT 'user', weight REAL DEFAULT 0.6,
          hits INTEGER DEFAULT 0, last_hit TEXT,
          created_at TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT
        )""")
        con.execute("""
        INSERT INTO memories(id,workspace_id,kind,content,entities,source,
                             weight,hits,created_at,updated_at)
        SELECT id, workspace_id, kind,
               COALESCE(NULLIF(content,''), text),
               COALESCE(entities,'[]'), COALESCE(source, src, 'user'),
               COALESCE(weight,0.6), COALESCE(hits,0),
               created_at, COALESCE(updated_at, created_at)
        FROM memories_old""")
        con.execute("DROP TABLE memories_old")
        con.execute("CREATE INDEX IF NOT EXISTS idx_mem_ws ON memories(workspace_id)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_mem_kind ON memories(kind)")
    con.commit()


# ---------------------------------------------------------------- 实体抽取

# 不引 NLP 库：学习场景里该被当「实体」的就是科目、知识点、日期、数量。
_SUBJ = re.compile(r"(高数|数学|英语|语文|C语言|C 语言|政治|专业课|计算机|物理|化学|"
                   r"专升本|考研|四级|六级)")
_KNOW = re.compile(r"(函数|极限|导数|积分|三角函数|数列|概率|语法|从句|时态|"
                   r"词汇|阅读|写作|指针|数组|链表|递归|结构体|排序|二分|"
                   r"定义|例题|错题|笔记|真题|计划|作息|效率|记忆|复习|"
                   r"院校|专业|考试|分数|弱项|强项|偏好|习惯)")
_DATE = re.compile(r"(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|"
                   r"这周|下周|本月|明天|后天)")
_NUM = re.compile(r"(\d+(?:\.\d+)?\s*(?:分钟|小时|天|个|道|讲|页|词))")


def extract_entities(text):
    """抽实体。抽不到就返回空数组 —— 不硬凑。"""
    t = str(text or "")
    out = []
    for pat in (_SUBJ, _KNOW, _DATE, _NUM):
        for m in pat.finditer(t):
            v = m.group(1).strip()
            if v and v not in out:
                out.append(v)
    return out[:12]


# ---------------------------------------------------------------- 写

def _norm(t):
    s = str(t or "").strip()
    s = re.sub(r"[\s，。、；：！？,.;:!?\"'「」（）()]+", "", s)
    return s.lower()


def add(content, kind="fact", source="user", weight=0.6,
        workspace_id=None, valid_from=None, valid_to=None, entities=None,
        allow_dup=False):
    """存一条记忆。

    判重：归一化后相同的不新增，只更新权重/有效期 —— 同一件事不该堆两条。
    `source='auto'` 的必须可纠正（界面能删），推错了人要能改。
    """
    t = str(content or "").strip()
    if not t:
        return {"ok": False, "error": "内容是空的"}
    t = t[:MAX_CONTENT]
    k = kind if kind in KINDS else "fact"
    try:
        w = max(0.0, min(1.0, float(weight)))
    except Exception:
        w = 0.6

    ents = entities if isinstance(entities, list) else extract_entities(t)
    con = store.connect()
    try:
        ensure_schema(con)
        key = _norm(t)
        rows = con.execute(
            "SELECT id,content FROM memories WHERE workspace_id IS ?", (workspace_id,)
        ).fetchall()
        # allow_dup：调用方自己管取代关系时用（learn_from_user）。
        # 判重会把「改主意」吞掉 —— 新说法和旧说法字面不同也可能算成同一条。
        for r in ([] if allow_dup else rows):
            if _norm(r["content"]) == key:
                con.execute(
                    "UPDATE memories SET weight=MAX(weight,?), updated_at=? WHERE id=?",
                    (w, _now(), r["id"]))
                con.commit()
                return {"ok": True, "id": r["id"], "dup": True,
                        "say": "这条我记着了（之前就有）"}
        mid = "m-%s-%03d" % (str(int(time.time() * 1000))[-9:], len(rows))
        con.execute(
            "INSERT INTO memories(id,workspace_id,kind,content,entities,source,"
            "weight,hits,created_at,valid_from,valid_to,updated_at)"
            " VALUES(?,?,?,?,?,?,?,0,?,?,?,?)",
            (mid, workspace_id, k, t, json.dumps(ents, ensure_ascii=False),
             source, w, _now(), valid_from or _now(), valid_to, _now()))
        con.commit()
        return {"ok": True, "id": mid, "content": t, "kind": k,
                "entities": ents, "weight": w,
                "say": "记住了（%s）：%s" % (KIND_CN.get(k, k), t)}
    finally:
        con.close()


def is_live(row, now=None):
    """这条记忆现在还算数吗。

    为什么要这个：人会变。上个月说「每天 150 分钟」，这周改成 120 ——
    旧那条如果不作废，检索时两条都会被捞出来，模型看到矛盾的两条只能猜。
    这不是"删"，是"封存"：内容留着（能查到历史），但不再参与作答。

    valid_to 为空 = 一直有效（绝大多数记忆都是这样）。
    """
    vt = (row or {}).get("valid_to")
    if not vt:
        return True
    now = now or time.strftime("%Y-%m-%d %H:%M:%S")
    return str(vt)[:19] > str(now)[:19]


def expire(mid, at=None):
    """封存一条记忆（不删）。"""
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute("UPDATE memories SET valid_to=?, updated_at=? WHERE id=?",
                    (at or _now(), _now(), mid))
        con.commit()
        return {"ok": True, "id": mid, "expired_at": at or _now()}
    finally:
        con.close()


def supersede(old_id, new_id=None):
    """一条新记忆取代旧的 —— 旧的封存，并连一条 refines 边。

    为什么留边：将来问「我以前是怎么定的」，顺着边能查到历史，
    而不是"被静默改掉，没人知道曾经是另一个数"。
    """
    r = expire(old_id)
    if new_id:
        try:
            link(new_id, old_id, "refines")
        except Exception as _e:
            _silent.log_squash(__name__, _e)
    return r


def link(from_id, to_id, relation="related", note=None):
    """连两条记忆。星图的边就是它。"""
    if not from_id or not to_id or from_id == to_id:
        return {"ok": False, "error": "两头要给不同的 id"}
    rel = relation if relation in RELATIONS else "related"
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute(
            "INSERT OR REPLACE INTO memory_links(from_id,to_id,relation,note,created_at)"
            " VALUES(?,?,?,?,?)", (from_id, to_id, rel, note, _now()))
        con.commit()
        return {"ok": True, "from": from_id, "to": to_id, "relation": rel}
    finally:
        con.close()


def auto_link(mid, workspace_id=None, threshold=1):
    """存完自动找相关的连起来：共享实体 >= threshold 就认为相关。

    为什么要自动：手写关联没人会去做，但星图没有边就只是散点。
    共享至少一个实体就算相关（本机记忆短、实体少，共享一个已经是信号）。
    """
    con = store.connect()
    try:
        ensure_schema(con)
        row = con.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
        if not row:
            return 0
        try:
            mine = set(json.loads(row["entities"] or "[]"))
        except Exception:
            mine = set()
        if not mine:
            return 0
        n = 0
        for r in con.execute(
                "SELECT id,entities FROM memories WHERE workspace_id IS ? AND id<>?",
                (workspace_id, mid)).fetchall():
            try:
                theirs = set(json.loads(r["entities"] or "[]"))
            except Exception:
                theirs = set()
            if len(mine & theirs) >= threshold:
                con.execute(
                    "INSERT OR REPLACE INTO memory_links(from_id,to_id,relation,note,created_at)"
                    " VALUES(?,?,?,?,?)", (mid, r["id"], "related",
                                           "共享：" + "、".join(sorted(mine & theirs)), _now()))
                n += 1
        con.commit()
        return n
    finally:
        con.close()


# ---------------------------------------------------------------- 读（多路检索）

def _bm25_like(tokens, text):
    """简易相关度：token 命中比例的平方根加权。不引依赖，够用。"""
    if not tokens:
        return 0.0
    t = str(text or "")
    hit = sum(1 for w in tokens if w and w in t)
    return (hit / len(tokens)) ** 0.5 if hit else 0.0


def _time_decay(valid_from, half_life_days=90):
    """时间衰减（借 Zep 的思路）：越久远的事实权重越低。

    但**只对事实/偏好衰减**，目标和困难点不该因为久远就被忽略。
    """
    if not valid_from:
        return 1.0
    try:
        ts = time.mktime(time.strptime(str(valid_from)[:19], "%Y-%m-%d %H:%M:%S"))
    except Exception:
        try:
            ts = time.mktime(time.strptime(str(valid_from)[:10], "%Y-%m-%d"))
        except Exception:
            return 1.0
    days = max(0.0, (time.time() - ts) / 86400.0)
    return 0.5 ** (days / half_life_sec(half_life_days))


def half_life_sec(days):
    return max(1.0, float(days))


_JIEBA = None


def _tokens_of(q):
    """把一句话切成词。

    **中文没有空格**，原来按空格/标点切，整句会变成一个 token，
    关键词路（BM25-like）永远匹配不上 —— 实测 tok 恒为 0，等于这一路白占权重。
    改用 jieba 分词（已装）；它没装时退回「汉字二元组」，仍比整句匹配强。
    """
    global _JIEBA
    q = (q or "").strip()
    if not q:
        return []
    if _JIEBA is None:
        try:
            import jieba  # noqa: F401
            _JIEBA = jieba
        except Exception:
            _JIEBA = False
    if _JIEBA:
        try:
            return [w.strip() for w in _JIEBA.lcut(q) if len(w.strip()) > 1 or w.strip().isdigit()]
        except Exception:
            pass
    # 兜底：按标点切 + 汉字二元组
    out = []
    for seg in re.split(r"[\s,，。、；：!?？!]+", q):
        seg = seg.strip()
        if not seg:
            continue
        if re.search(r"[\u4e00-\u9fa5]", seg):
            out.extend(seg[i:i + 2] for i in range(max(1, len(seg) - 1)))
        else:
            out.append(seg)
    return out


def recall(q, workspace_id=None, limit=10, kind=None):
    """多路召回 + 重排（Hindsight 的思路）。

    四路：
      1. 子串（整串命中，最强信号）
      2. 分词（题里的词分散命中）
      3. 实体（query 里出现过的实体，与记忆的 entities 求交）
      4. 时间（近期优先，但目标/困难点不衰减）

    合并去重后按综合分排序：每路归一化后加权相加。
    """
    q = str(q or "").strip()
    con = store.connect()
    try:
        ensure_schema(con)
        sql = "SELECT * FROM memories WHERE workspace_id IS ?"
        args = [workspace_id]
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        pool = [dict(r) for r in con.execute(sql, args).fetchall()]
        # 过期的不参与作答 —— 内容还留着（能查历史），但不再当"现在的事实"。
        # 少了这一步，改过主意之后旧说法还会被检索出来，模型看到矛盾的两条只能猜。
        pool = [r for r in pool if is_live(r)]
        if not pool:
            return []

        if not q:
            pool.sort(key=lambda r: (-(r.get("weight") or 0), r.get("updated_at") or ""))
            return pool[:limit]

        tokens = _tokens_of(q)
        qents = set(extract_entities(q))

        # 向量路：query 只算一次，循环里只做点积（每轮对话都要跑这条路，
        # 把「编码」这一步提到循环外，条数多了差别很明显）。
        qvec = None
        try:
            from . import embed as _emb
            # query 和文档**用不同的编码模式**：
            # bge 训练时 query 带指令前缀、文档不带，混用会明显掉分。
            qvec = _emb.encode_query(q)
        except Exception:
            qvec = None

        scored = []
        for r in pool:
            text = r.get("content") or ""
            try:
                ments = set(json.loads(r.get("entities") or "[]"))
            except Exception:
                ments = set()

            s_sub = 1.0 if q and q in text else 0.0
            s_tok = _bm25_like(tokens, text)
            s_ent = (len(qents & ments) / len(qents)) if qents else 0.0
            decay = 1.0 if r.get("kind") in ("goal", "difficulty") \
                else _time_decay(r.get("valid_from"))
            s_time = decay
            w = float(r.get("weight") or 0.5)

            # 第五路：向量。老数据没有向量（这一轮之前存的），
            # 现算一次并回填 —— 一次性成本，之后就都有值了。
            s_vec_raw = 0.0
            if qvec is not None:
                try:
                    from . import embed as _emb
                    rv = _emb.from_blob(r.get("embedding"))
                    if rv is None:
                        rv = _emb.encode(text)
                        try:
                            con.execute("UPDATE memories SET embedding=? WHERE id=?",
                                        (_emb.to_blob(rv), r.get("id")))
                            con.commit()
                        except Exception as _e:
                            _silent.log_squash(__name__, _e)
                    s_vec_raw = max(0.0, _emb.cosine(qvec, rv))
                except Exception:
                    s_vec_raw = 0.0
            r["_vec_raw"] = s_vec_raw

            # 分层加成（Letta 三层）：core 是"关于他是谁"的东西，
            # 泛泛的问题（"我今天学什么"）也该把目标和弱项带出来 ——
            # 不带的话模型会给一个跟他的处境无关的答案。
            try:
                from . import layers as _ly
                lay = _ly.layer_of(r)
                boost = _ly.rank_boost(lay)
            except Exception:
                lay, boost = "recall", 0.0

            score = (s_sub * 3.0) + (s_tok * 2.0) + (s_ent * 2.5) \
                + (s_time * 0.5) + (w * 1.2) + boost
            if score <= 0:
                continue
            r["_score"] = round(score, 3)
            r["_layer"] = lay
            r["_why"] = {
                "sub": s_sub > 0, "tok": round(s_tok, 2),
                "ent": round(s_ent, 2), "vec": round(s_vec_raw, 3),
                "decay": round(decay, 2), "layer": lay,
            }
            scored.append(r)

        # 向量分归一到「本批相对位置」。
        # 为什么必须归一：bge-small 在短中文句上，无关项也能到 0.3+，
        # 直接把 0.28 和 0.45 都乘同一个权重，等于给全体加常数 ——
        # 那不算「参与了排序」。归一之后最好的是 1、最差的是 0，
        # 向量才真正在「这一批里挑谁」上起作用。
        raws = [float(r.pop("_vec_raw", 0.0) or 0.0) for r in scored]
        if raws:
            lo, hi = min(raws), max(raws)
            span = hi - lo
            for r, raw in zip(scored, raws):
                # 全挤在一起（span 极小）说明向量没看出差别 —— 老实给 0，别硬凑
                rel = ((raw - lo) / span) if span > 0.01 else 0.0
                r["_score"] = round(r["_score"] + rel * 3.0, 3)
                if isinstance(r.get("_why"), dict):
                    r["_why"]["vec"] = round(raw, 3)
                    r["_why"]["vec_rel"] = round(rel, 2)
        scored.sort(key=lambda r: -r["_score"])
        return scored[:limit]
    finally:
        con.close()


def all_(workspace_id=None, kind=None, limit=300, include_expired=False):
    con = store.connect()
    try:
        ensure_schema(con)
        sql = "SELECT * FROM memories WHERE workspace_id IS ?"
        args = [workspace_id]
        if kind:
            sql += " AND kind=?"
            args.append(kind)
        sql += " ORDER BY weight DESC, updated_at DESC LIMIT ?"
        args.append(int(limit))
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def links_of(workspace_id=None, ids=None):
    """给星图用：这个工作区里所有的边。"""
    con = store.connect()
    try:
        ensure_schema(con)
        if ids is None:
            rows = con.execute(
                "SELECT m.id FROM memories m WHERE m.workspace_id IS ?", (workspace_id,)
            ).fetchall()
            ids = [r["id"] for r in rows]
        if not ids:
            return []
        ph = ",".join("?" * len(ids))
        return [dict(r) for r in con.execute(
            "SELECT * FROM memory_links WHERE from_id IN (%s) AND to_id IN (%s)" % (ph, ph),
            list(ids) + list(ids)).fetchall()]
    finally:
        con.close()


def update(mid, **kw):
    con = store.connect()
    try:
        ensure_schema(con)
        row = con.execute("SELECT * FROM memories WHERE id=?", (mid,)).fetchone()
        if not row:
            return {"ok": False, "error": "没有这条记忆"}
        sets, args = [], []
        for k in ("content", "kind", "weight", "valid_to", "source"):
            if k in kw and kw[k] is not None:
                v = kw[k]
                if k == "content":
                    v = str(v)[:MAX_CONTENT]
                if k == "kind" and v not in KINDS:
                    continue
                if k == "weight":
                    try:
                        v = max(0.0, min(1.0, float(v)))
                    except Exception:
                        v = 0.5
                sets.append("%s=?" % k)
                args.append(v)
        if not sets:
            return {"ok": True, "m": dict(row)}
        sets.append("updated_at=?")
        args.append(_now())
        args.append(mid)
        con.execute("UPDATE memories SET %s WHERE id=?" % ",".join(sets), args)
        con.commit()
        return {"ok": True, "m": dict(con.execute(
            "SELECT * FROM memories WHERE id=?", (mid,)).fetchone())}
    finally:
        con.close()


def drop(mid):
    """删一条记忆（连同它的边）。auto 来源的尤其要能删。"""
    con = store.connect()
    try:
        ensure_schema(con)
        n = con.execute("DELETE FROM memories WHERE id=?", (mid,)).rowcount
        if n:
            con.execute("DELETE FROM memory_links WHERE from_id=? OR to_id=?", (mid, mid))
        con.commit()
        return {"ok": n > 0, "error": "" if n else "没有这条记忆"}
    finally:
        con.close()


def hit(mid):
    con = store.connect()
    try:
        ensure_schema(con)
        con.execute("UPDATE memories SET hits=hits+1, last_hit=? WHERE id=?", (_now(), mid))
        con.commit()
        return True
    except Exception:
        return False
    finally:
        con.close()


def prompt_note(workspace_id=None, limit=12):
    """塞进系统提示的那一段 —— Letta 三层在这里真正发挥作用。

    **旧做法的问题**：按权重取前 12 个。库里 200 条的话，
    这 12 条今天这一次、明天那一次，每轮都在赌运气 ——
    模型的行为跟着提示漂。这是"记忆"最反直觉的失败方式：
    东西都记着，但每次只捞上来一部分，于是它每次都像第一次认识你。

    **新做法**：三层配比
        core      常驻，**稳定**          → 每轮都在，模型对"他是谁"的认识不漂
        recall    近期活跃，滚动          → 这一阵子在用的东西
        archival  不进提示                → 老的记着，但别占位置

    配比不是五五分：core 最多 12 条里占到大概 7~8 条（目标和困难点本来就少），
    剩下的给 recent。archival 一条都不进 —— 它靠检索被翻出来，
    而不是靠常驻占地方。
    """
    try:
        from . import layers as _ly
    except Exception:
        _ly = None

    rows = all_(workspace_id=workspace_id, limit=200)
    if not rows:
        return ""

    if _ly is None:
        # 兜底：分层模块坏了也不能让系统提示没记忆
        picked = rows[:limit]
        lines = ["", "【关于他，你该记得的事】"]
        for r in picked:
            lines.append("- [%s] %s" % (KIND_CN.get(r["kind"], r["kind"]), r["content"]))
        lines.append("（别重复问；记错了用 memory_drop 删掉。）")
        return "\n".join(lines)

    sp = _ly.split(rows)
    core = sp[_ly.CORE]
    recent = sp[_ly.RECALL]

    # core 按权重降序（目标、困难点排在前面），recent 按最近动过降序
    core.sort(key=lambda r: -(float(r.get("weight") or 0.5)))
    recent.sort(key=lambda r: str(r.get("last_hit") or r.get("updated_at") or ""), reverse=True)

    picked = core[:max(1, limit - 4)]
    room = max(0, limit - len(picked))
    picked += recent[:room]

    if not picked:
        return ""

    lines = ["", "【关于他，你该记得的事】"]
    for r in picked:
        lines.append("- [%s] %s" % (KIND_CN.get(r["kind"], r["kind"]), r["content"]))
    lines.append("（别重复问；记错了用 memory_drop 删掉。）")

    # 归档层给一行提示就够 —— 让模型知道"还有别的东西，需要时去搜"，
    # 而不是把那些内容也搬进提示里。这一行几乎不花 token，但改变了行为：
    # 不知道有归档的存在，它就会说"我不记得"；知道有，它会去 memory_search。
    if sp[_ly.ARCHIVAL]:
        lines.append("（另外还记着 %d 条更早的事，需要时用 memory_search 查。）"
                     % len(sp[_ly.ARCHIVAL]))
    return "\n".join(lines)


def _cur_ws():
    """当前工作区。抽出来的记忆必须挂在某个工作区下 ——
    挂在工作区外面的记忆，界面上永远看不见（星图按工作区筛），
    等于「记了但没人知道」。这里兜一道底：拿不到就用存档里的 current。"""
    try:
        from . import store as _st
        return _st.kv_get("ws.current") or None
    except Exception:
        return None


def _conflicts(new_row, pool):
    """找出会被这条新记忆取代的旧记忆。

    **只在同一类型里找** —— 「把每天 150 分钟改成 120」只该顶掉
    同类里那条「每天 150 分钟」，不该把「目标是省内一本」也顶掉。

    判据用向量相似度（有的话）+ 关键词重叠：
    两条说的不是一件事，就不该互相覆盖。**宁可留着不删，也不要误删**
    —— 误删是数据丢失，留着最多是检索时出现两条旧信息（还能人工纠正）。
    """
    kind = new_row.get("kind")
    text = str(new_row.get("content") or "")
    if not text or not kind:
        return []
    # 谁能顶掉谁。
    # 「把每天150分钟改成120」是一条 change，它要顶掉的是 pref 里那条
    # 「每天能学150分钟」—— 这两条**类型不同**，但说的是一件事。
    # 只在同类型里找，就会留下两条互相矛盾的记忆（实测）。
    SUPERSEDES = {
        "change": ("change", "pref", "fact", "goal"),
        "goal": ("goal",),
        "difficulty": ("difficulty",),
        "pref": ("pref",),
        "fact": ("fact",),
    }
    allow = SUPERSEDES.get(kind, (kind,))
    out = []
    for r in pool:
        if r.get("kind") not in allow:
            continue
        if not is_live(r):
            continue
        other = str(r.get("content") or "")
        if not other:
            continue
        same = False
        # 1) 向量相近（同一件事换个说法）
        try:
            from . import embed as _emb
            va = _emb.from_blob(r.get("embedding"))
            vb = _emb.encode(text)
            if va is not None:
                same = _emb.cosine(va, vb) >= 0.82
        except Exception as _e:
            _silent.log_squash(__name__, _e)
        # 2) **同一个"话题槽"**：都讲每天多久 / 都讲考试日期 / 都讲弱项科目。
        # 口语里的变更常常只有一句半截话（"每天改成90分钟"），
        # 跟旧条的字面重叠很少，靠关键词是抓不到的 —— 但话题是一样的，
        # 那就该顶掉。这一条比下面的词重叠更能抓住真实说法。
        if not same:
            SLOT = (
                ("分钟", "小时", "每天", "时长"),
                ("考试", "考", "日期", "月", "号"),
                ("弱项", "不会", "搞不懂", "绕不出来", "差", "混"),
                # 作息/偏好单独一槽：它跟"每天学多久"是两件事，
                # 少了这一槽，「每天能学150分钟，晚上效率高」会被当成纯时长记忆整条封掉。
                ("晚上", "早上", "效率", "作息", "精神", "状态"),
            )
            for slot in SLOT:
                if any(w in other for w in slot) and any(w in text for w in slot):
                    # **但一条旧记忆里可能装着两件事**：
                    # 「每天能学 150 分钟，晚上效率高」——
                    # 前半句过时了，后半句（作息偏好）没过时。
                    # 整条封存等于把"晚上效率高"也一起判死了。
                    #
                    # 判据：旧条如果**在别的话题槽里也有内容**，就不整条封，
                    # 留给人工/后续处理。宁可留着一条旧的，也不要丢掉一条对的。
                    other_slots = 0
                    for s2 in SLOT:
                        if s2 is slot:
                            continue
                        if any(w in other for w in s2):
                            other_slots += 1
                    if other_slots == 0:
                        same = True
                    break
        # 3) 关键片段重叠（"每天 150 分钟"在两句话里都出现）
        if not same:
            import re as _re
            ka = set(_re.findall(r"[0-9]+|[\u4e00-\u9fa5]{2,4}", other))
            kb = set(_re.findall(r"[0-9]+|[\u4e00-\u9fa5]{2,4}", text))
            if ka and kb:
                ov = len(ka & kb) / max(1, min(len(ka), len(kb)))
                same = ov >= 0.6
        if same:
            out.append(r.get("id"))
    return out


def learn_from_user(text, workspace_id=None):
    """从用户这一句话里抽记忆并落库（写时抽取，见 extract.py）。

    为什么放在这里而不是 agent 里：
    「抽什么、怎么判重、要不要建边、要不要顶掉旧的」都是关于记忆的规则，
    属于这一层；agent 只该负责「什么时候调它」。

    **一条新记忆可能让旧记忆作废**（这一版加的）：
    他说「每天改成 120」，那之前那条「每天 150」就不该再当现状用。
    做法是**封存**（写 valid_to）而不是删除 —— 历史留着，只是不再参与作答。
    """
    from . import extract as ex
    workspace_id = workspace_id or _cur_ws()
    got = ex.extract(text)
    out = []
    for kind, content, weight in got:
        # 先落新的，再让旧的失效：顺序反了的话，
        # 万一 add 失败（判重/异常），旧记忆就已经被封存，等于凭空丢一条。
        # 这里**不用 add 的判重**：判重会把「把150分钟改成120」判成
        # 和旧的「把150分钟改成120」重复，合并进旧条，新信息就丢了。
        # 取代关系本来就该由下面的 supersede 表达（新条 + 旧条封存 + refines 边），
        # 不是靠「合并成一条」。
        r = add(content, kind=kind, weight=weight, source="auto",
                workspace_id=workspace_id, allow_dup=True)
        if not (r.get("ok") and r.get("id")):
            continue
        superseded = []
        # 取代检测**不看 dup**。
        #
        # 一开始写成 `if not r.get("dup")`，结果一条都没被封存 ——
        # 因为 add() 的判重把「把每天150分钟改成120」判成了和旧那条重复，
        # 直接合并进旧记忆、返回 dup=True，取代逻辑整个被跳过。
        #
        # 而且要**排除它自己**：判重合并时返回的 id 就是旧那条的 id，
        # 不排掉会出现「自己封存自己」。
        if True:
            try:
                pool = all_(workspace_id=workspace_id, limit=300, include_expired=False)
                for old in _conflicts({"kind": kind, "content": content}, pool):
                    if old and old != r["id"]:
                        supersede(old, r["id"])
                        superseded.append(old)
            except Exception as _e:
                _silent.log_squash(__name__, _e)
        try:
            auto_link(r["id"], workspace_id)
        except Exception as _e:
            _silent.log_squash(__name__, _e)
        out.append({"id": r["id"], "kind": kind, "content": content,
                    "weight": weight, "dup": bool(r.get("dup")),
                    "superseded": superseded})
    return out


def stats(workspace_id=None):
    """统计：种类分布 + **三层分布** + 向量覆盖率。

    三层分布要放进统计里，因为它是这一版最该被看见的东西 ——
    「哪些事每轮都在我脑子里、哪些只是记着」是这个系统对人的承诺，
    不显示出来的话，用户没法判断它到底记住了什么、忘了什么。
    """
    con = store.connect()
    try:
        ensure_schema(con)
        rows = con.execute(
            "SELECT * FROM memories WHERE workspace_id IS ?", (workspace_id,)).fetchall()
        pool = [dict(r) for r in rows]
        by = {}
        for r in pool:
            by[r["kind"]] = by.get(r["kind"], 0) + 1
        used = sum(1 for r in pool if (r.get("hits") or 0) > 0)
        nl = con.execute(
            "SELECT COUNT(*) c FROM memory_links l "
            "JOIN memories m ON m.id=l.from_id WHERE m.workspace_id IS ?",
            (workspace_id,)).fetchone()["c"]

        # 三层分布（现算，不存字段 —— 见 layers.py 开头的说明）
        lay = {"core": 0, "recall": 0, "archival": 0}
        try:
            from . import layers as _ly
            sp = _ly.split(pool)
            lay = {k: len(v) for k, v in sp.items()}
        except Exception as _e:
            _silent.log_squash(__name__, _e)

        # 向量覆盖：老数据在这一轮之前没有 embedding，检索时才会回填。
        has_vec = sum(1 for r in pool if r.get("embedding"))

        return {"total": len(pool), "by_kind": by,
                "used": used, "links": nl,
                "layers": lay,
                "vector": dict({"covered": has_vec, "total": len(pool)},
                               **_vec_info()),
                "kinds": [{"k": k, "cn": KIND_CN.get(k, k), "n": by.get(k, 0)}
                          for k in list(KINDS) + [x for x in by if x not in KINDS]]}
    finally:
        con.close()


def _vec_info():
    """向量后端信息：用的是什么模型、多少维、为什么降级。

    这三件事必须**对用户可见**：他要知道自己机器的记忆检索
    到底在用什么。降级到哈希还假装一切正常，是最不该做的。
    """
    try:
        from . import embed as _e
        d = _e.info()
        return {"dim": d.get("dim", 0), "backend": d.get("backend"),
                "model": d.get("model"), "why": d.get("fallback_reason") or ""}
    except Exception as e:
        return {"dim": 0, "backend": "none", "model": "", "why": str(e)[:60]}


# ============================================================
# 工具处理层（从 tools.py 搬过来的领域逻辑）
#
# 为什么放在这里而不是留在 tools.py：
#   tools.py 已经是 7866 行的上帝文件，而这几个函数的**全部内容**
#   都是对本模块的调用 —— 属于记忆领域，不属于工具注册层。
#   放回去之后 tools.py 只剩一行 @tool 包装，改记忆规则不用再碰上帝文件。
#
# 为什么不直接把 @tool 装饰器也搬过来：那会让本模块 import tools.py，
# 而 tools.py 顶层已经 import 了一堆模块 —— 会**制造新的循环依赖**
# （审计指出 tools.py ↔ agent.py 已有一环了）。
# 所以：**领域逻辑归领域，注册归注册**，两边用薄函数连接。
# ============================================================

def handle_add(text=None, kind="fact", weight=0.6, wid=None):
    """memory_add：他说了目标/弱项/作息/偏好时记一条。"""
    r = add(text, kind=kind, weight=weight, source="user", workspace_id=wid)
    if r.get("ok") and r.get("id"):
        auto_link(r["id"], wid)
    return r


def handle_recall(q=None, k=5, limit=None, wid=None):
    """memory_recall：按需检索的主入口。

    字段必须叫 memories，不能叫 items —— 后者在 tools._WS_LIST_FIELDS 里，
    而记忆没有 subject，整段会被清空成 []（坑 11 已踩过多次）。
    """
    q = (q or "").strip()
    if not q:
        return {"ok": False, "error": "要查什么？给一句自然语言就行，比如「他的作息」"}
    try:
        k = max(1, min(20, int(limit if limit is not None else (k or 5))))
    except Exception:
        k = 5
    rows = recall(q, workspace_id=wid, limit=k)
    for r in rows:
        hit(r["id"])
    if not rows:
        return {"ok": True, "n": 0, "q": q,
                "say": "记忆里没有跟「%s」相关的事。" % q,
                "memories": []}
    return {"ok": True, "n": len(rows), "q": q,
            "memories": [{"id": r["id"], "kind": r["kind"],
                          "content": r["content"],
                          "layer": r.get("_layer"),
                          "score": r.get("_score"),
                          "why": r.get("_why")} for r in rows]}


def handle_search(q=None, limit=12, wid=None):
    """memory_search：memory_recall 的旧名字，保留兼容。

    注意：字段名用 memories 而不是 items（后者会被工作区过滤清空）。
    """
    rows = recall(q or "", workspace_id=wid, limit=int(limit or 12))
    for r in rows:
        hit(r["id"])
    return {"ok": True, "n": len(rows),
            "memories": [{"id": r["id"], "kind": r["kind"], "content": r["content"],
                          "weight": r["weight"], "why": r.get("_why")} for r in rows]}


def handle_correct(id=None, content=None):
    """memory_correct：旧说法封存、换新的，并连 refines 边。

    不直接改 content —— 那样等于把历史抹掉，「他以前说过 150，后来改成 120」
    这两句话都有价值。所以是封存 + 新增，不是覆盖。
    """
    if not id:
        return {"ok": False, "error": "要纠正哪一条？给 id（先用 memory_recall 查到）"}
    if not (content or "").strip():
        return {"ok": False, "error": "改成什么？给新的说法"}
    con = store.connect()
    try:
        row = con.execute("SELECT * FROM memories WHERE id=?", (str(id),)).fetchone()
        if not row:
            return {"ok": False, "error": "没有这条记忆"}
        old = dict(row)
    finally:
        con.close()
    r = add(content, kind=old.get("kind") or "fact",
            weight=old.get("weight") or 0.6, source="correct",
            workspace_id=old.get("workspace_id"), allow_dup=True)
    if not (r.get("ok") and r.get("id")):
        return r
    supersede(str(id), r["id"])
    return {"ok": True, "old": old.get("content"), "new": content,
            "old_id": str(id), "new_id": r["id"],
            "say": "改过来了：原来记的是「%s」，现在是「%s」。旧的那条留着能查，但不再当现状用。"
                   % (str(old.get("content") or "")[:40], content[:40])}


def handle_list(kind=None, limit=50, wid=None):
    rows = all_(workspace_id=wid, kind=kind, limit=int(limit or 50))
    return {"ok": True, "n": len(rows),
            "memories": [{"id": r["id"], "kind": r["kind"], "content": r["content"],
                          "weight": r["weight"], "source": r["source"],
                          "hits": r["hits"]} for r in rows]}


def handle_drop(id=None):
    if not id:
        return {"ok": False, "error": "要删哪一条？传 id"}
    return drop(str(id))
