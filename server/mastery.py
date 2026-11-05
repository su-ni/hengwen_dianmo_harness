# -*- coding: utf-8 -*-
"""熟练度（第 11 章 D33/D35）—— 判断模型的两层之一。

**两层分工**（文档 11.1）：
    FSRS       决定「下次什么时候复习」—— 纯时间调度，算得出来
    自建模型    决定「这次算不算真的会了」—— 需要判断，这里先落数据

这一版做的是**地基**：建表、接 FSRS、把每次作答的真实信号存下来。
自建小模型的训练是**晚一步**的事（D36：先采数据，训练晚一步）。
理由很实在：现在 answers 表只有 7 条，训练什么都训不出来 ——
但「7 条」会变成「700 条」，前提是现在就开始按训练样本的格式存。

**为什么不是只给单词做**
第 11 章 D35 明确要求「覆盖所有科目与题型，不止单词」。
所以表的主键是 (subject, item_kind, item_id) 而不是 word。

**为什么 FSRS 参数和掌握度分两列**
它们回答的是两个问题，不该混：
    fsrs_*     什么时候该再看一眼（时间）
    model_*    到底会不会（判断）
一条记忆可以「明天该复习」但「其实已经会了」，反过来也成立。
"""
from __future__ import annotations

import datetime as dt
import time

from . import store
from . import silent as _silent

# FSRS 的「学习步骤」必须改成按天 —— 这是这一版最重要的一个设置。
#
# FSRS 默认 learning_steps = (1 分钟, 10 分钟)，那是给 Anki 那种
# 「一天坐下来刷几百张卡」的场景设计的：新卡当场反复问到记住为止。
#
# 但备考不是这样：**一个人一天只学一次**。
# 排到 1 分钟后 = 他今天已经关电脑了 = 这个复习点永远排不上，
# 界面上的「到期」会一直是脏的（实测：答对排 9 分钟后、答错排 1 分钟后）。
#
# 所以按天的节奏来：
#   学会了   → 明天再来一次，然后交给 FSRS 的长间隔
#   没学会   → 明天再来（不隔 1 分钟，也不隔一周）
# 这也符合人的学习规律：当天再刷一遍没有意义，睡一觉才是真的巩固。
LEARNING_STEPS = (dt.timedelta(days=1),)
RELEARNING_STEPS = (dt.timedelta(days=1),)
# 间隔封顶 60 天，不是 365。
#
# 实测：FSRS 默认参数下，答对 2 次就排到 153 天后、3 次排到 359 天后。
# 那是给「长期记忆库」设计的 —— 而备考是**几个月内要考**，
# 排到半年后等于这条从此不再复习，考前正好忘光。
#
# 60 天是个折中：够长（不用天天刷）、够短（考前一定能再见到一次）。
# 这不是拍脑袋 —— 备考周期按 3~6 个月算，60 天能保证每条至少还见 2~3 次。
MAX_INTERVAL = 60

AGAIN = "again"
HARD = "hard"
GOOD = "good"
EASY = "easy"
RATINGS = (AGAIN, HARD, GOOD, EASY)
ITEM_KINDS = ("word", "question", "knowledge", "grammar", "formula")

_F = None


def _fsrs():
    """惰性加载 fsrs —— 它是可选依赖，没装也不能让整个服务起不来。"""
    global _F
    try:
        from fsrs import Scheduler, Card, Rating
    except Exception:
        return None
    if _F is None:
        _F = {
            "Scheduler": Scheduler, "Card": Card, "Rating": Rating,
            "map": {AGAIN: Rating.Again, HARD: Rating.Hard,
                    GOOD: Rating.Good, EASY: Rating.Easy},
        }
    return _F


def ensure_schema(con):
    con.execute("""
    CREATE TABLE IF NOT EXISTS mastery(
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      subject TEXT,
      item_kind TEXT NOT NULL DEFAULT 'word',
      item_id TEXT NOT NULL,
      fsrs_stability REAL,
      fsrs_difficulty REAL,
      fsrs_due TEXT,
      fsrs_step INTEGER DEFAULT 0,
      fsrs_state INTEGER DEFAULT 1,
      model_score REAL,
      model_reason TEXT,
      model_src TEXT DEFAULT 'rule',
      seen INTEGER DEFAULT 0,
      right INTEGER DEFAULT 0,
      wrong INTEGER DEFAULT 0,
      avg_ms INTEGER,
      last_rating TEXT,
      last_ts TEXT,
      created_at TEXT,
      updated_at TEXT
    )""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_mastery_item "
                "ON mastery(workspace_id, item_kind, item_id)")
    con.execute("""
    CREATE TABLE IF NOT EXISTS training_samples(
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      item_kind TEXT,
      item_id TEXT,
      subject TEXT,
      prompt TEXT,
      response TEXT,
      elapsed_ms INTEGER,
      hesitations INTEGER,
      correct INTEGER,
      model_score REAL,
      model_src TEXT DEFAULT 'rule',
      reviewed_at TEXT,
      anonymized INTEGER DEFAULT 0,
      created_at TEXT
    )""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_ts_item "
                "ON training_samples(workspace_id, item_kind, item_id)")
    con.commit()


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _mid(workspace_id, item_kind, item_id):
    return "m-%s-%s-%s" % (str(workspace_id or "-"), item_kind, str(item_id))


def rule_score(row, elapsed_ms=None, hesitations=0):
    """**没有模型时**的掌握度 —— 规则算的，不是猜的。

    这是 D36「先采数据，训练晚一步」里那个「晚一步」之前的东西。
    它必须存在，而且必须**能解释**，否则模型训出来之前整个熟练度是空壳。

    四个信号：正确率（最直接）、最近一次（遗忘曲线）、耗时（会了反应快）、
    犹豫（改答案说明不稳）。输出 0..1 + 一句人话理由 ——
    界面要显示「为什么判它是 0.6」，不然就是黑箱。
    """
    seen = int(row.get("seen") or 0)
    right = int(row.get("right") or 0)
    wrong = int(row.get("wrong") or 0)
    if seen <= 0:
        return 0.35, "还没练过"

    acc = right / max(1, right + wrong)
    last = (row.get("last_rating") or "").strip()
    last_w = {"again": -0.25, "hard": -0.05, "good": 0.08, "easy": 0.12}.get(last, 0.0)
    conf = min(1.0, seen / 5.0)

    score = 0.25 + acc * 0.55 + last_w

    if elapsed_ms and row.get("avg_ms"):
        avg = float(row.get("avg_ms") or 0)
        if avg > 0:
            ratio = float(elapsed_ms) / avg
            if ratio > 1.8:
                score -= 0.08
            elif ratio < 0.6:
                score += 0.05

    if hesitations and hesitations > 0:
        score -= min(0.15, 0.06 * int(hesitations))

    score = 0.35 + (score - 0.35) * conf
    score = max(0.0, min(1.0, score))

    reason = "正确率 %d/%d" % (right, right + wrong)
    if last:
        reason += "，最近一次" + {"again": "全错", "hard": "勉强",
                                  "good": "答对", "easy": "很轻松"}.get(last, last)
    if seen < 5:
        reason += "（只练过 %d 次，把握有限）" % seen

    # 模型接管（第 11 章）：训过就用模型的判断，没训过就老实用规则。
    # 关键：**不要假装用了模型** —— src 会一路带到界面上，让人知道这个数哪来的。
    try:
        from . import judge as _jd
        ms, mwhy, src = _jd.predict(
            {"seen": seen, "right": right, "wrong": wrong,
             "avg_ms": row.get("avg_ms"), "correct": (last in (GOOD, EASY)),
             "last_rating": last},
            elapsed_ms=elapsed_ms, hesitations=hesitations)
        if src == "model":
            return ms, mwhy
    except Exception as _e:
        _silent.log_squash(__name__, _e)
    return round(score, 2), reason


def record(item_id, item_kind="word", subject=None, rating=GOOD,
           correct=None, elapsed_ms=None, hesitations=0,
           prompt=None, response=None, workspace_id=None):
    """记一次作答：同时更新 FSRS 调度、掌握度，并落一条训练样本。

    三件事一次做完，因为它们**必须一致** —— 分开写会出现
    「熟练度涨了但 FSRS 没动」这种状态，之后没人说得清哪个对。
    """
    item_id = str(item_id or "").strip()
    if not item_id:
        return {"ok": False, "error": "没给 item_id"}
    item_kind = item_kind if item_kind in ITEM_KINDS else "word"
    rating = rating if rating in RATINGS else GOOD
    if correct is None:
        correct = rating in (GOOD, EASY)

    con = store.connect()
    try:
        ensure_schema(con)
        mid = _mid(workspace_id, item_kind, item_id)
        row = con.execute("SELECT * FROM mastery WHERE id=?", (mid,)).fetchone()
        cur = dict(row) if row else {"seen": 0, "right": 0, "wrong": 0}

        seen = int(cur.get("seen") or 0) + 1
        right = int(cur.get("right") or 0) + (1 if correct else 0)
        wrong = int(cur.get("wrong") or 0) + (0 if correct else 1)
        avg_ms = cur.get("avg_ms")
        if elapsed_ms:
            avg_ms = int(elapsed_ms) if not avg_ms else int((int(avg_ms) * (seen - 1) + int(elapsed_ms)) / seen)

        due_s, stab, diff, step, state = None, None, None, 0, 1
        f = _fsrs()
        if f:
            try:
                sched = f["Scheduler"](
                    learning_steps=LEARNING_STEPS,
                    relearning_steps=RELEARNING_STEPS,
                    maximum_interval=MAX_INTERVAL,
                )
                card = f["Card"]()
                if cur.get("fsrs_due"):
                    try:
                        card.due = dt.datetime.fromisoformat(str(cur["fsrs_due"]))
                    except Exception as _e:
                        _silent.log_squash(__name__, _e)
                if cur.get("fsrs_stability"):
                    card.stability = cur["fsrs_stability"]
                if cur.get("fsrs_difficulty"):
                    card.difficulty = cur["fsrs_difficulty"]
                card.step = int(cur.get("fsrs_step") or 0)
                card2, _log = sched.review_card(card, f["map"][rating])
                due_s = card2.due.isoformat() if card2.due else None
                stab, diff = card2.stability, card2.difficulty
                step, state = int(card2.step or 0), int(getattr(card2.state, "value", 1))

                # ---- 头几次压住间隔 ----
                #
                # FSRS 第 2 次答对就敢排到 57 天后（实测）。它算的是
                # 「这条记忆的稳定度」，而不是「这个人还有多久考试」。
                # 对长期记忆库没问题，对备考不行：一个新知识点只见过两次，
                # 排到两个月后，考前那次正好是第一次遗忘。
                #
                # 所以前几次按固定节奏走（1 / 3 / 7 天），
                # 见够三次以上才交给 FSRS 自己算 —— 那时它才有足够信号。
                # 这不是不信任 FSRS，是**在数据不足时给它一个合理起点**。
                # 判据只用 seen，不看 state ——
                # FSRS 在答对第一次后 state 就从 Learning(1) 变 Review(2)，
                # 用 state 当条件等于永远不生效（实测：加了跟没加一样）。
                if seen <= 3 and rating in (GOOD, EASY):
                    _bootstrap = {1: 1, 2: 3, 3: 7}.get(seen)
                    if _bootstrap:
                        _d = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=_bootstrap)
                        due_s = _d.isoformat()
            except Exception as _e:
                _silent.log_squash(__name__, _e)

        probe = {"seen": seen, "right": right, "wrong": wrong,
                 "avg_ms": avg_ms, "last_rating": rating}
        score, reason = rule_score(probe, elapsed_ms=elapsed_ms, hesitations=hesitations)
        # src 要如实反映：模型训过就是 model，没训过就是 rule
        try:
            from . import judge as _jd
            _src = "model" if _jd.status().get("trained") else "rule"
        except Exception:
            _src = "rule"

        now = _now()
        con.execute("""
        INSERT INTO mastery(id,workspace_id,subject,item_kind,item_id,
            fsrs_stability,fsrs_difficulty,fsrs_due,fsrs_step,fsrs_state,
            model_score,model_reason,model_src,
            seen,right,wrong,avg_ms,last_rating,last_ts,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            fsrs_stability=excluded.fsrs_stability,
            fsrs_difficulty=excluded.fsrs_difficulty,
            fsrs_due=excluded.fsrs_due,
            fsrs_step=excluded.fsrs_step,
            fsrs_state=excluded.fsrs_state,
            model_score=excluded.model_score,
            model_reason=excluded.model_reason,
            seen=excluded.seen, right=excluded.right, wrong=excluded.wrong,
            avg_ms=excluded.avg_ms, last_rating=excluded.last_rating,
            last_ts=excluded.last_ts, updated_at=excluded.updated_at
        """, (mid, workspace_id, subject, item_kind, item_id,
              stab, diff, due_s, step, state,
              score, reason, _src,
              seen, right, wrong, avg_ms, rating, now,
              cur.get("created_at") or now, now))

        try:
            con.execute("""
            INSERT INTO training_samples(id,workspace_id,item_kind,item_id,subject,
                prompt,response,elapsed_ms,hesitations,correct,
                model_score,model_src,reviewed_at,anonymized,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
            """, ("t-%d-%s" % (int(time.time() * 1000000), mid[-6:]),
                  workspace_id, item_kind, item_id, subject,
                  (prompt or "")[:2000], (response or "")[:2000],
                  elapsed_ms, int(hesitations or 0), 1 if correct else 0,
                  score, "rule", now, now))
        except Exception as _e:
            _silent.log_squash(__name__, _e)

        con.commit()
        return {"ok": True, "score": score, "reason": reason,
                "due": due_s, "next_in": _human_due(due_s),
                "seen": seen, "acc": round(right / max(1, right + wrong), 2)}
    finally:
        con.close()


def _human_due(due_s):
    """把「下次什么时候」翻成人话 —— 界面上不该出现 ISO 时间戳。"""
    if not due_s:
        return ""
    try:
        d = dt.datetime.fromisoformat(str(due_s))
        now = dt.datetime.now(d.tzinfo) if d.tzinfo else dt.datetime.now()
        sec = (d - now).total_seconds()
    except Exception:
        return ""
    if sec <= 0:
        return "今天该复习"
    # 一律按天说。按分钟说会让人以为"等会儿还要再来一遍"，
    # 而实际节奏是一天一次 —— 界面上写成「1 分钟后」是误导。
    days = sec / 86400.0
    # 用 round 而不是 int：排 1 天 = 24 小时后，算出 0.9999 天，
    # int() 会截成 0 天显示「今天」—— 那等于告诉人「现在就该复习」，
    # 而实际是明天（实测踩过：第一次答对显示成「今天」）。
    d = int(round(days))
    if d <= 0:
        return "今天该复习"
    if d == 1:
        return "明天"
    return "%d 天后" % d


def get(item_id, item_kind="word", workspace_id=None):
    con = store.connect()
    try:
        ensure_schema(con)
        row = con.execute("SELECT * FROM mastery WHERE id=?",
                          (_mid(workspace_id, item_kind, item_id),)).fetchone()
        return dict(row) if row else None
    finally:
        con.close()


def due_items(workspace_id=None, item_kind=None, limit=50):
    """到期待复习的，按 FSRS 的 due 排。"""
    con = store.connect()
    try:
        ensure_schema(con)
        sql = "SELECT * FROM mastery WHERE workspace_id IS ?"
        args = [workspace_id]
        if item_kind:
            sql += " AND item_kind=?"
            args.append(item_kind)
        rows = [dict(r) for r in con.execute(sql, args).fetchall()]
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        out = [r for r in rows if r.get("fsrs_due") and str(r["fsrs_due"]) <= now]
        out.sort(key=lambda r: str(r.get("fsrs_due") or ""))
        return out[:limit]
    finally:
        con.close()


def stats(workspace_id=None):
    """概览。训练样本数是**这一层能不能往下走的关键指标** ——
    界面上要能看到它涨，否则没人知道「先采数据」这件事有没有在做。"""
    con = store.connect()
    try:
        ensure_schema(con)
        rows = [dict(r) for r in con.execute(
            "SELECT * FROM mastery WHERE workspace_id IS ?", (workspace_id,)).fetchall()]
        n = len(rows)
        avg = round(sum(float(r.get("model_score") or 0) for r in rows) / n, 2) if n else 0.0
        by_kind = {}
        for r in rows:
            k = r.get("item_kind") or "word"
            by_kind[k] = by_kind.get(k, 0) + 1
        # 最薄的几条：界面上要能直接看到「哪几个最不牢」。
        # 门槛放在 0.6 而不是 0.5 —— 0.5 以下其实已经很少了，
        # 真需要盯的是 0.5~0.6 这一档（"勉强会"正是最容易被高估的）。
        weak = sorted([r for r in rows if (r.get("model_score") or 0) < 0.6],
                      key=lambda r: (r.get("model_score") or 0))[:8]
        # 全部条目按掌握度排（界面要画分布，不只是给个平均分）
        all_sorted = sorted(rows, key=lambda r: -(r.get("model_score") or 0))
        now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
        due_n = sum(1 for r in rows if r.get("fsrs_due") and str(r["fsrs_due"]) <= now_iso)
        samples = con.execute(
            "SELECT COUNT(*) c FROM training_samples WHERE workspace_id IS ?",
            (workspace_id,)).fetchone()["c"]
        # 分数分布：五档，界面画成条 —— 比一个平均分有用得多
        buckets = [0, 0, 0, 0, 0]
        for r in rows:
            sc = float(r.get("model_score") or 0)
            buckets[min(4, int(sc * 5))] += 1
        return {
            "total": n, "avg_score": avg, "by_kind": by_kind,
            "samples": samples, "due": due_n,
            "buckets": buckets,
            "weak": [{"item_id": r["item_id"], "kind": r.get("item_kind"),
                      "score": r.get("model_score"), "reason": r.get("model_reason"),
                      "subject": r.get("subject")}
                     for r in weak],
            "top": [{"item_id": r["item_id"], "kind": r.get("item_kind"),
                     "score": r.get("model_score")} for r in all_sorted[:5]],
        }
    finally:
        con.close()


# ============================================================
# 工具处理层（从 tools.py 搬过来的领域逻辑，见 memories.py 同名段的说明）
# ============================================================

# rating 的各种传法 → 四档。
# 实测踩过：模型传 rating:0 表示「全错」，而 str(0)="0" 不在合法值里被
# 悄悄降级成 good —— 答错记成答对，还排到 143 天后复习。
# 这类「数据错了但没人报错」的 bug 最坏，所以映射表写死在这里。
RATING_MAP = {
    "0": "again", "1": "hard", "2": "good", "3": "easy",
    "again": "again", "hard": "hard", "good": "good", "easy": "easy",
    "wrong": "again", "fail": "again", "no": "again", "false": "again",
    "true": "good", "right": "good", "ok": "good",
    "勉强": "hard", "会": "good", "不会": "again", "错": "again",
}


def handle_record(item_id=None, item_kind="word", subject=None, rating="good",
                  elapsed_ms=None, hesitations=0, prompt=None, response=None, wid=None):
    """mastery_record：记一次作答（FSRS 调度 + 掌握度 + 训练样本，一次做完）。

    **直接记，不要先搜题库**：用户说「我刚做了递归那道题，答错了」是真实作答，
    没带题号就用 prompt 当主题。实测踩过：模型先扫 828 条题库没找到，
    回「挂不上题号」然后什么都没记 —— 一次真实信号就这么丢了。
    """
    _id = str(item_id or "").strip() or str(prompt or "").strip()[:40]
    if not _id:
        return {"ok": False, "error": "要记哪一项？给 item_id 或 prompt（比如「递归」）"}

    # 用主题词当 id 时归 knowledge 而不是 word ——
    # 「递归」不是英语单词，归成 word 会污染词汇量统计（实测踩过）。
    _kind = item_kind or "knowledge"
    if not str(item_id or "").strip() and str(_kind) == "word":
        _kind = "knowledge"

    _rating = RATING_MAP.get(str(rating).strip().lower(), "good")
    return record(_id, item_kind=_kind, subject=subject, rating=_rating,
                  elapsed_ms=elapsed_ms, hesitations=hesitations,
                  prompt=prompt, response=response, workspace_id=wid)


def handle_list(due=0, item_kind=None, limit=20, wid=None):
    """mastery_list：概览 / 到期列表。字段不叫 items（会被工作区过滤清空）。"""
    if str(due) in ("1", "true", "yes"):
        rows = due_items(workspace_id=wid, item_kind=item_kind, limit=int(limit or 20))
        return {"ok": True, "n": len(rows),
                "due": [{"item_id": r["item_id"], "kind": r.get("item_kind"),
                         "score": r.get("model_score"), "reason": r.get("model_reason"),
                         "next_in": _human_due(r.get("fsrs_due"))} for r in rows]}
    return {"ok": True, **stats(workspace_id=wid)}
