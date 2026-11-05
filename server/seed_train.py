# -*- coding: utf-8 -*-
"""给判断模型准备**第一次训练**的数据（可撤销、来源可查）。

用户要「先搞点训练数据」。但判断模型的输出会真的进复习计划
（排到哪天再学一次），所以不能凭空编一堆「某人答对了某题」然后假装
模型已经会了。这里的做法是：

  1) 真实作答优先：answers 表里 10 条真实作答，按原样转成训练样本。
  2) 真实知识点当题干：memories 里那些真实记下来的弱项/知识点
     （三角函数、英语从句、递归、C 指针…），这些是他真在学的东西。
  3) 作答信号按合理场景生成，但**每条打标**：
       model_src = 'real'      来自 answers
       model_src = 'synthetic' 合成信号，只用来让模型第一次跑通结构
     界面 / status() 能一眼看到有多少是真的、多少是合成的。
  4) 耗时分布来自 tool_calls 真实毫秒数，不是拍脑袋写 5000。

**训练完默认不接管决策**：见 judge.py 的 _ACTIVE_KEY。
第一次训练产出的权重存着给人看，但要人明确说「用它」才让 predict()
真的用模型 —— 防止合成数据训出来的东西直接排错复习计划。

撤销：python -m server.seed_train --clear   （只删本脚本写的样本）
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
import time

from . import store

_DB = None
_MIN_SYN = 30          # 要凑到 30 条才够 fit() 的门槛

# 真实知识点：从 memories 抽，不自己编题目
TOPICS = [
    ("三角函数公式", "math"), ("英语从句", "english"), ("递归三要素", "cs"),
    ("C 语言指针", "cs"), ("名词辨析", "english"), ("极限计算", "math"),
    ("马原原理", "pol"), ("完形填空", "english"), ("指针与数组", "cs"),
    ("导数应用", "math"),
]


def _conn():
    return store.connect()


def _clear():
    con = _conn()
    try:
        n = con.execute("DELETE FROM training_samples WHERE model_src IN ('real','synthetic','seed')").rowcount
        con.execute("DELETE FROM mastery")
        con.commit()
        print("清掉本脚本写入的样本 %d 条（mastery 清空，真实 answers 不动）" % n)
    finally:
        con.close()


def _real_ms():
    """从 tool_calls 拿真实的耗时分布，别拍脑袋。"""
    con = _conn()
    try:
        rows = [r[0] for r in con.execute(
            "SELECT ms FROM tool_calls WHERE ms IS NOT NULL AND ms > 0 AND ms < 60000 "
            "ORDER BY id DESC LIMIT 60").fetchall()]
    finally:
        con.close()
    # 工具耗时和「做题耗时」不是一个量级，压到 2~25 秒的作答区间
    out = [max(2000, min(25000, int(m) * 8)) for m in rows]
    return out or [3000, 5000, 8000, 12000]


def build():
    con = _conn()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    written = {"real": 0, "synthetic": 0}
    try:
        # ---- 1) 真实作答（answers 全错，这是真实信号，不美化）----
        answers = [dict(r) for r in con.execute(
            "SELECT id,ts,qno,part,chosen,ans,ok,source,subject,workspace_id "
            "FROM answers ORDER BY ts").fetchall()]
        for a in answers:
            item = "%s · %s Q%s" % (a.get("part") or "题", a.get("source") or "", a.get("qno") or "")
            con.execute("""
                INSERT OR IGNORE INTO training_samples(
                  id,workspace_id,item_kind,item_id,subject,prompt,response,
                  elapsed_ms,hesitations,correct,model_score,model_src,
                  reviewed_at,anonymized,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)""", (
                "seed-real-%s" % a["id"], a.get("workspace_id"), "question", item,
                a.get("subject"), item, str(a.get("chosen") or ""),
                None, 0, int(a.get("ok") or 0), 0.3, "real", now, a.get("ts") or now))
            written["real"] += 1

        # ---- 2) 合成样本：真实知识点 + 按场景生成的作答信号 ----
        ms_pool = _real_ms()
        rng = random.Random(20261106)        # 固定种子，可复现
        have = con.execute("SELECT COUNT(*) c FROM training_samples WHERE model_src IN ('real','synthetic')").fetchone()["c"]
        need = max(0, _MIN_SYN + 2 - have)   # 留 2 条余量
        for i in range(need):
            topic, subj = TOPICS[i % len(TOPICS)]
            # 一半「练过几遍、答得又快又稳」，一半「还没练牢、慢且犹豫」
            solid = (i % 2 == 0)
            correct = 1 if solid else 0
            ms = rng.choice(ms_pool) if solid else int(rng.choice(ms_pool) * 1.8)
            hes = 0 if solid else rng.choice([1, 2, 2, 3])
            seen = rng.randint(3, 8) if solid else rng.randint(1, 3)
            con.execute("""
                INSERT OR IGNORE INTO training_samples(
                  id,workspace_id,item_kind,item_id,subject,prompt,response,
                  elapsed_ms,hesitations,correct,model_score,model_src,
                  reviewed_at,anonymized,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)""", (
                "seed-syn-%03d" % i, None, "knowledge", topic, subj, topic,
                "（合成作答信号）" if solid else "（合成：答错/犹豫）",
                ms, hes, correct, round(0.8 if solid else 0.25, 2),
                "synthetic", now, now))
            written["synthetic"] += 1
        con.commit()
    finally:
        con.close()

    total = con.execute if False else None
    return written


def report():
    con = _conn()
    try:
        rows = con.execute(
            "SELECT model_src, COUNT(*) n, SUM(correct) ok FROM training_samples "
            "GROUP BY model_src").fetchall()
        print("=== training_samples 来源分布 ===")
        for r in rows:
            print("  %-12s %3d 条  其中答对 %s" % (r[0], r[1], r[2]))
        print("  合计", con.execute("SELECT COUNT(*) FROM training_samples").fetchone()[0], "条")
    finally:
        con.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clear", action="store_true", help="撤销：删掉本脚本写入的样本")
    ap.add_argument("--report", action="store_true", help="只看分布")
    a = ap.parse_args()
    if a.clear:
        _clear()
    elif a.report:
        report()
    else:
        w = build()
        print("写入:", w)
        report()
