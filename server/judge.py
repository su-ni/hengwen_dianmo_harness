# -*- coding: utf-8 -*-
"""自建判断小模型（第 11 章 D33/D35/D36）。

用户说「别等数据了，先建模型」—— 那就建，但**按能负责的方式建**：

  · 它是**可插拔**的：一条 `predict()` 接口，规则版永远兜底。
  · 它是**可解释**的：每次输出带一句人话理由，不是黑箱数字。
  · 它是**可训练**的：样本够了用 `fit()` 从 training_samples 学一组权重，
    学到的参数存 kv，重启不丢；样本不够就明确说「还没训，用规则版」。

**为什么不是神经网络 / 不是 sklearn**：
training_samples 现在是 0 条。上任何模型都会给出"看起来很准"的假数字，
而这里的每一个数都会进复习计划（排到哪天再见一次）—— 假数字会真的耽误人。
所以这一版做的是**结构**：特征、训练、持久化、接管规则，全部就位，
数据一到就能 fit，不用改调用方。

特征（对应文档 11.3 的输入）：
    correct        这次对没对
    elapsed_ms     耗时
    hesitations    犹豫次数
    acc_hist       历史正确率
    seen           这个点练过几次
    kind           题型（word / question / knowledge …）

输出：掌握度 0..1 + 一句话理由。
"""
from __future__ import annotations

import json
import math
import time

from . import store

# 权重存在 kv 里，重启不丢；没训过就是 None
_W_KEY = "judge.model.v1"
_MIN_SAMPLES = 30            # 少于这个数不训 —— 30 条以下拟合出来的就是噪声

# 特征名（顺序即权重顺序，别乱改；改了要把 kv 里的旧向量作废）
FEATURES = ("bias", "correct", "acc_hist", "speed", "hesitation", "seen", "confidence")


def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def features(row, elapsed_ms=None, hesitations=0):
    """把一条作答记录变成特征向量。所有分量都压到 -1..1 或 0..1，
    不然量纲差几千倍（毫秒 vs 正确率），训练出来的权重全被耗时带跑。"""
    seen = int(row.get("seen") or 0)
    right = int(row.get("right") or 0)
    wrong = int(row.get("wrong") or 0)
    correct = 1.0 if (row.get("correct") in (1, True, "1")) or (row.get("last_rating") in ("good", "easy")) else 0.0
    acc_hist = right / max(1, right + wrong)

    # 速度：相对这个点自己的历史均值。没有基线就记 0（中性），不乱猜
    speed = 0.0
    if elapsed_ms and row.get("avg_ms"):
        avg = float(row["avg_ms"] or 0)
        if avg > 0:
            speed = max(-1.0, min(1.0, math.log(max(0.1, float(elapsed_ms) / avg))))

    hes = min(1.0, float(hesitations or 0) / 3.0)
    seen_f = min(1.0, seen / 10.0)
    conf = min(1.0, seen / 5.0)     # 样本量置信度

    return {
        "bias": 1.0, "correct": correct, "acc_hist": acc_hist,
        "speed": -speed,            # 越慢越不利，取负号让权重方向统一
        "hesitation": hes, "seen": seen_f, "confidence": conf,
    }


def _vec(f):
    return [float(f.get(k, 0.0)) for k in FEATURES]


def _sigmoid(x):
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def _load():
    """读已训练的模型。返回 None 表示还没有模型 —— 调用方必须据此回退规则版。"""
    try:
        raw = store.kv_get(_W_KEY)
        if not raw:
            return None
        d = json.loads(raw)
        w = d.get("w") or []
        if len(w) != len(FEATURES):
            return None          # 特征变了？旧向量作废，别硬套
        return d
    except Exception:
        return None


def predict(row, elapsed_ms=None, hesitations=0):
    """判断这次算不算真的会了。返回 (score, reason, src)。

    没训过 → src='rule'，明确告诉界面「这是规则算的，不是模型」。
    """
    m = _load()
    f = features(row, elapsed_ms=elapsed_ms, hesitations=hesitations)
    if m is None:
        # 规则兜底：跟 mastery.rule_score 同一套信号，但这里只出"这一轮"的分
        s = 0.25 + 0.45 * f["correct"] + 0.20 * f["acc_hist"]
        s += 0.06 * f["speed"] - 0.12 * f["hesitation"]
        s = max(0.0, min(1.0, s))
        return round(s, 2), "还没训过模型，按规则估的（正确率/速度/犹豫）", "rule"

    w = m["w"]
    z = sum(a * b for a, b in zip(_vec(f), w))
    s = max(0.0, min(1.0, _sigmoid(z)))
    # 理由：把贡献最大的两个特征说出来，人能看懂
    contrib = sorted(zip(FEATURES[1:], [a * b for a, b in zip(_vec(f)[1:], w[1:])]),
                     key=lambda x: -abs(x[1]))[:2]
    why = "、".join("%s%s" % (k, "偏高" if v > 0 else "偏低") for k, v in contrib)
    return round(s, 2), "模型判的：" + (why or "综合信号"), "model"


def status():
    """给界面看：现在用的是模型还是规则，训练了多少条，什么时候训的。"""
    m = _load()
    con = store.connect()
    try:
        n = con.execute("SELECT COUNT(*) c FROM training_samples").fetchone()["c"]
    finally:
        con.close()
    return {
        "trained": m is not None,
        "src": "model" if m else "rule",
        "samples": n,
        "min_samples": _MIN_SAMPLES,
        "ready": n >= _MIN_SAMPLES,
        "trained_at": (m or {}).get("at"),
        "features": list(FEATURES),
        "weights": (m or {}).get("w"),
    }


def fit():
    """从 training_samples 学一组权重（逻辑回归，梯度下降，纯标准库）。

    为什么用逻辑回归而不是更花的东西：
      · 可解释 —— 每个权重对应一个特征，界面能说清"为什么判 0.6"；
      · 样本少时不容易过拟合；
      · 纯 Python 就能跑，不加依赖。

    标签用 `correct`（他这次对没对）。这是**弱监督**：
    严格说「答对了」不等于「真会了」，但它是目前唯一的真值信号，
    而且比我们自己拍的分数客观。文档 11.3 里也是这么定的。
    """
    con = store.connect()
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT prompt,response,elapsed_ms,hesitations,correct,item_kind,item_id "
            "FROM training_samples ORDER BY created_at").fetchall()]
    finally:
        con.close()

    if len(rows) < _MIN_SAMPLES:
        return {"ok": False,
                "error": "样本只有 %d 条，至少要 %d 条才训。现在硬训出来的是噪声，"
                         "而它会被拿去排复习计划 —— 不能拿假的耽误人。"
                         % (len(rows), _MIN_SAMPLES),
                "samples": len(rows)}

    # 按 item 聚合出历史特征（这道题以前对过几次）
    hist = {}
    for r in rows:
        k = str(r.get("item_id") or "")
        h = hist.setdefault(k, {"right": 0, "wrong": 0, "ms": []})
        h["right" if r.get("correct") else "wrong"] += 1
        if r.get("elapsed_ms"):
            h["ms"].append(int(r["elapsed_ms"]))

    X, Y = [], []
    for r in rows:
        k = str(r.get("item_id") or "")
        h = hist[k]
        avg = int(sum(h["ms"]) / len(h["ms"])) if h["ms"] else 0
        f = features({
            "seen": h["right"] + h["wrong"],
            "right": h["right"], "wrong": h["wrong"],
            "correct": r.get("correct"), "avg_ms": avg,
        }, elapsed_ms=r.get("elapsed_ms"), hesitations=r.get("hesitations") or 0)
        X.append(_vec(f))
        Y.append(1.0 if r.get("correct") else 0.0)

    w = [0.0] * len(FEATURES)
    lr, steps, l2 = 0.12, 260, 0.002
    n = len(X)
    for _ in range(steps):
        g = [0.0] * len(w)
        for x, y in zip(X, Y):
            z = sum(a * b for a, b in zip(x, w))
            d = _sigmoid(z) - y
            for j in range(len(w)):
                g[j] += d * x[j]
        for j in range(len(w)):
            # bias 不做正则
            w[j] -= lr * (g[j] / n + (0 if j == 0 else l2 * w[j]))

    model = {"w": [round(v, 4) for v in w], "at": _now(),
             "n": n, "features": list(FEATURES)}
    store.kv_set(_W_KEY, json.dumps(model, ensure_ascii=False))

    # 训练后自查：在训练集上的准确率，别报个好看的数就完事
    ok = 0
    for x, y in zip(X, Y):
        p = _sigmoid(sum(a * b for a, b in zip(x, w)))
        ok += 1 if (p >= 0.5) == (y >= 0.5) else 0
    return {"ok": True, "samples": n, "weights": model["w"],
            "train_acc": round(ok / n, 3), "at": model["at"],
            "note": "这是训练集自查，不是泛化能力。样本还少时别把它当结论。"}


def reset():
    """删掉模型，退回规则版。训练错了要能退回来。"""
    con = store.connect()
    try:
        con.execute("DELETE FROM kv WHERE k=?", (_W_KEY,))
        con.commit()
    finally:
        con.close()
    return {"ok": True, "say": "已删掉模型，退回规则版"}


# ============================================================
# 工具处理层（从 tools.py 搬过来的领域逻辑）
# ============================================================

def handle_train():
    """judge_train：样本不够会明确拒绝，不硬训。"""
    return fit()


def handle_status():
    """judge_status：界面要能一眼看出「这个数是模型判的还是规则估的」。"""
    return {"ok": True, **status()}


def handle_reset():
    """judge_reset：训错了能退回来。"""
    return reset()
