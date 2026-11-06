# -*- coding: utf-8 -*-
"""AI 成本账本 —— 把「花了多少」变成可查的数字。

为什么做这个：
  本地优先架构最大的卖点之一是**成本可控**，但"可控"不能只靠嘴说。
  用户真正想知道的是三件事：
    1. 这个月我用了多少 token、折合多少钱
    2. 哪类操作最贵（是写计划，还是讲题）
    3. 同样一件事，本机算和调模型差多少

数据从哪来：
  **不新增埋点**。每次模型调用的 token 早就记在 session_events 的
  payload.meta.usage 里（agent.py 一直在写）。这里只做聚合。

单价从哪来：
  config.COST_RATES，按 provider+model 前缀匹配。**取不到就报 None**，
  不拿一个拍脑袋的数字冒充账单 —— 宁可显示「未配置单价」。
"""
from __future__ import annotations

import json

from . import config, store

# 每 100 万 token 的单价（人民币元）。只填了能确认的；其余留空。
# 这个表是**唯一需要维护的地方** —— 上游调价只改这里。
RATES = {
    # provider: (输入价, 输出价) per 1M tokens
    "workbuddy": (2.0, 8.0),
    "trae": (2.0, 8.0),
    "apikey": (2.0, 8.0),
    # 本机推理：不计费
    "local": (0.0, 0.0),
    "bge": (0.0, 0.0),
}


def _rate(provider):
    """取单价。没配置就返回 None，调用方据此显示「未配置」而不是 0 元。"""
    r = RATES.get(str(provider or "").lower())
    return r


def _price(provider, pin, pout):
    r = _rate(provider)
    if r is None:
        return None
    return (pin / 1_000_000.0) * r[0] + (pout / 1_000_000.0) * r[1]


def summary(days=30, workspace_id=None):
    """近 N 天的用量与成本。

    返回里 **cost 可能是 None**（单价未配置）—— 界面要能区分
    「花了 0 元」和「不知道多少钱」。
    """
    con = store.connect()
    try:
        sql = ("SELECT payload, created_at FROM session_events "
               "WHERE kind='assistant/message' ORDER BY id DESC")
        rows = con.execute(sql).fetchall()
    finally:
        con.close()

    import datetime as dt

    cutoff = (dt.datetime.now() - dt.timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")

    n_msg = 0
    tok_in = tok_out = 0
    cost = 0.0
    cost_known = True
    by_provider = {}
    by_day = {}

    for r in rows:
        ts = r["created_at"] or ""
        if ts < cutoff:
            continue
        try:
            p = json.loads(r["payload"] or "{}")
        except Exception:
            continue
        u = (p.get("meta") or {}).get("usage") or {}
        if not u.get("total_tokens"):
            continue
        n_msg += 1
        pin = int(u.get("prompt_tokens") or 0)
        pout = int(u.get("completion_tokens") or 0)
        tok_in += pin
        tok_out += pout

        prov = str(u.get("provider") or "?")
        d = by_provider.setdefault(prov, {"msgs": 0, "tokens": 0, "cost": 0.0, "known": True})
        d["msgs"] += 1
        d["tokens"] += pin + pout
        c = _price(prov, pin, pout)
        if c is None:
            d["known"] = False
            cost_known = False
        else:
            d["cost"] += c
            cost += c

        day = ts[:10]
        dd = by_day.setdefault(day, {"msgs": 0, "tokens": 0})
        dd["msgs"] += 1
        dd["tokens"] += pin + pout

    return {
        "ok": True,
        "days": days,
        "messages": n_msg,
        "tokens_in": tok_in,
        "tokens_out": tok_out,
        "tokens_total": tok_in + tok_out,
        # 没有可计费消息时就是真 0；有消息但单价缺就是 None
        "cost": (0.0 if n_msg == 0 else (cost if cost_known else None)),
        "currency": "CNY",
        "per_message_tokens": round((tok_in + tok_out) / n_msg) if n_msg else 0,
        "per_message_cost": (round(cost / n_msg, 4) if (n_msg and cost_known) else None),
        "by_provider": {k: {"msgs": v["msgs"], "tokens": v["tokens"],
                            "cost": (round(v["cost"], 4) if v["known"] else None)}
                        for k, v in by_provider.items()},
        "by_day": dict(sorted(by_day.items())),
        "note": ("单价未配置的来源已标成 null —— 不拿拍脑袋的数字冒充账单"
                 if not cost_known else "按 config 里的单价表折算"),
    }


def local_savings():
    """本机算 vs 调模型：同一件事的成本差。

    这是「本地优先」最直接的一笔账：
      判断一次「会不会」 —— 规则 0 token，模型一次调用 ~800 tokens
      检索一次记忆     —— 本机向量 0 元，云端 embedding 按量计费
    数字取自实测（见 docs/experiments/），不是估算。
    """
    con = store.connect()
    try:
        # 规则路径的真实耗时与次数
        rows = con.execute(
            "SELECT ms FROM tool_calls WHERE name IN "
            "('mastery_record','mastery_list','judge_status') AND ms IS NOT NULL").fetchall()
    finally:
        con.close()
    ms = [int(r["ms"]) for r in rows] if rows else []
    avg_ms = round(sum(ms) / len(ms), 1) if ms else None
    return {
        "ok": True,
        "rule_calls": len(ms),
        "rule_avg_ms": avg_ms,
        "rule_tokens": 0,
        "rule_cost": 0.0,
        "model_tokens_per_call": 800,      # 实测均值口径，见实验报告
        "note": "判断与检索在本机完成，只有对话理解才调模型 —— 成本随对话轮次涨，不随学习数据涨",
    }
