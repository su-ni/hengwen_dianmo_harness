# -*- coding: utf-8 -*-
"""Letta 三层记忆：core / recall / archival（第 9 章 D30）。

文档 9.1 里对 Letta 的评价是「架构漂亮但过重（是运行时不是库）」，
所以之前没采用。这一轮采用它，但**只采用分层思想，不搬它那套运行时**：

    core      常驻      进系统提示，每轮都看得见。**极少**，超了要挤出去。
    recall    近期      这一阵子在用的，检索时优先。
    archival  归档      老的和不常用的，检索得到，但不占提示。

**为什么要分层，而不是一张表加个权重**
一张表 + 权重，等于把所有记忆压成一个维度：权重高的永远在前面，
权重低的永远沉底 —— 但它们其实是**不同用途**的东西，不该可比。
「3 月 15 号考试」是 core，「上周问过递归」是 recall，「半年前学过指针」是 archival，
它们之间没有"谁更重要"，只有"谁会在这轮用上"。

**为什么分层能省 token**
之前 prompt_note 是按权重取前 12 个塞进系统提示。库里 200 条的话，
这 12 条可能今天这条、明天那条，每轮都在赌运气。
分成三层后 core 是稳定的那几条（目标/弱项/偏好），
recall 按最近使用滚动，archival 完全不进提示 ——
提示稳定了，模型的行为也就稳定了。这是"省 token"之外的真正收益。

**怎么分层（不是拍脑袋定的）**
    · goal / difficulty        → core      它们决定"怎么教"，永远要有
    · 近 7 天写过或读过的       → recall
    · 其余                      → archival

这一条是**判定规则**不是**状态标记**：每次查询现算，不存字段。
为什么：存字段就要维护迁移（一条记忆今天在 recall，30 天后该自动降级，
那得有个定时任务去翻）。现算是纯函数，永远正确，而且不用管历史数据。
"""
from __future__ import annotations

import time

CORE = "core"
RECALL = "recall"
ARCHIVAL = "archival"

LAYERS = (CORE, RECALL, ARCHIVAL)
LAYER_CN = {CORE: "常驻", RECALL: "近期", ARCHIVAL: "归档"}

# core 的上限。超过了就从最"旧"的那条挤出去（挤到 recall，不删）。
# 为什么要有上限：core 是每轮都进系统提示的，20 条就是 20 行 × N 轮。
# 提示一长，模型对后半段的注意力会掉 —— 那等于"我记得，但我不看"。
CORE_MAX = 14

RECENT_DAYS = 7             # 多少天内动过算"近期"


def _parse_ts(v):
    if not v:
        return 0.0
    try:
        return time.mktime(time.strptime(str(v)[:19], "%Y-%m-%d %H:%M:%S"))
    except Exception:
        try:
            return time.mktime(time.strptime(str(v)[:10], "%Y-%m-%d"))
        except Exception:
            return 0.0


def layer_of(row, now=None):
    """一条记忆属于哪层。纯函数 —— 同样的输入永远同样的输出。

    判定顺序就是优先级：先看类型（目标和困难点永远核心），
    再看活跃度（最近动过 → 近期），剩下的归档。
    """
    now = now or time.time()
    kind = row.get("kind") or "fact"

    # 1. 决定"怎么教"的类型，永远常驻
    # insight 跟 difficulty 归一类：它们都在说「他哪里不行 / 该往哪使劲」，
    # 是决定"怎么教"的依据，不该因为时间久就沉下去。
    if kind in ("goal", "difficulty", "insight"):
        return CORE

    # 2. 有命中记录且在近期窗口内 → 近期
    last = _parse_ts(row.get("last_hit"))
    if last and (now - last) <= RECENT_DAYS * 86400:
        return RECALL

    # 3. 最近写/改过 → 近期
    upd = _parse_ts(row.get("updated_at") or row.get("created_at"))
    if upd and (now - upd) <= RECENT_DAYS * 86400:
        return RECALL

    return ARCHIVAL


def split(rows, now=None):
    """把一批记忆分成三堆。返回 {layer: [rows]}。

    core 超过上限时，按「权重降序 + 越新越前」保留，其余降到 recall。
    为什么是降到 recall 而不是丢：它还是关于他的事，
    只是这一阵子不该每轮都占着系统提示的位置。
    """
    now = now or time.time()
    out = {CORE: [], RECALL: [], ARCHIVAL: []}
    for r in rows:
        out[layer_of(r, now)].append(r)

    if len(out[CORE]) > CORE_MAX:
        out[CORE].sort(key=lambda r: (
            -(float(r.get("weight") or 0.5)),
            -_parse_ts(r.get("updated_at") or r.get("created_at")),
        ))
        overflow = out[CORE][CORE_MAX:]
        out[CORE] = out[CORE][:CORE_MAX]
        out[RECALL].extend(overflow)

    return out


def hint_of(rows):
    """给界面/调试用：每层几条，一眼看出分布。"""
    sp = split(rows)
    return {k: len(v) for k, v in sp.items()}


def rank_boost(layer):
    """分层对检索排序的加成。

    为什么 core 还要加成：core 是"关于他是谁"的东西，
    一个泛泛的问题（"我今天学什么"）也该把目标/弱项带出来 ——
    不带的话模型会给出一个跟他的处境无关的答案。
    """
    return {CORE: 1.6, RECALL: 0.5, ARCHIVAL: 0.0}.get(layer, 0.0)


def preview(rows, days=(0, 7, 30, 90)):
    """未来会怎么分层 —— 让人现在就能验证「三个月后归档层会不会有东西」。

    为什么需要它：archival 恒为 0 不是逻辑错，是**数据还太新**
    （所有记忆都在 7 天内动过）。但"现在看不到"不等于"以后看不到"，
    也不能就这么放着不管 —— 三个月后才发现分层不对，那时数据已经乱了。

    这个函数把同样的判定跑在未来几个时间点上，
    用的还是 layer_of 这个纯函数，不是另写一套算法。
    """
    out = []
    for d in days:
        fake_now = time.time() + d * 86400
        sp = split(rows, now=fake_now)
        out.append({
            "after_days": d,
            "core": len(sp[CORE]),
            "recall": len(sp[RECALL]),
            "archival": len(sp[ARCHIVAL]),
        })
    return out
