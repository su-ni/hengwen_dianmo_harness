# -*- coding: utf-8 -*-
"""本地向量：真语义 RAG（bge-small-zh）＋ 哈希向量兜底。

**为什么用 bge-small-zh-v1.5**
本机 HF 缓存里已经有它（BAAI/bge-small-zh-v1.5，中文语义嵌入专用，~90MB）。
用它有三个好处，全都对应这个项目的约束：
  · **纯本地**：模型在磁盘上，不联网、不外发 —— 记忆里装的是他的目标和弱项，
    这是最私的数据，不该为了一条排序把它送出门。
  · **中文友好**：bge-zh 是在中文语料上训的，能懂「学得进去」和「效率高」是同一件事。
    这正是上一版哈希向量做不到的（实测 0.05，几乎等于无关）。
  · **够小**：90MB / 512 维，CPU 上一句话 10ms 量级，几十条记忆完全无压力。

**为什么还要哈希兜底**
不能假设每台机器都装了 torch。bge 起不来时（没装 transformers、
模型没缓存、显存/内存不够）必须还能跑 —— 降级到字符 n-gram 哈希，
检索质量下降但功能不断。**能降级的功能才叫功能，一装不上就崩的是隐患。**

**为什么 embedding 要存库而不是每次现算**
虽然单条只要 10ms，但检索每轮对话都跑，几十条就是几百毫秒。
写在 add 时算一次存起来（1536 或 2048 字节），读的时候只做点积 —— 微秒级。
老数据没有向量的，第一次检索时补算并回填。

向量维度取决于用什么后端，所以**不写死**：blob 里带上维度语义，
读的时候按实际长度判断（见 from_blob）。
"""
from __future__ import annotations

import hashlib
import math
import os
import re
import threading
from . import silent as _silent

# ---------------- 后端探测（一次性，结果缓存） ----------------
_BACKEND = None          # 'bge' | 'hash'
_MODEL = None
_DIM = 0
_ERR = ""
# 后端探测必须串行：FastAPI 的同步路由跑在线程池里，
# 两个请求同时进来会并发 import torch/transformers —— 实测偶发 ImportError，
# 然后被 except 吞掉、**永久降级成 hash 直到重启**。这个坑很阴：
# 单独跑脚本永远是好的，只有服务里偶发。
_LOCK = threading.Lock()


def _try_bge():
    """试着加载 bge-small-zh。成功返回 (model, dim)，失败返回 (None, 0)。

    只试一次就记住结果 —— 每次检索都去 import torch 会拖慢整条路径，
    而「这台机器上 torch 能不能用」在进程生命周期内不会变。
    """
    global _ERR
    try:
        import torch  # noqa: F401
        from transformers import AutoTokenizer, AutoModel
    except Exception as e:
        _ERR = "没装 transformers/torch：%s" % str(e)[:80]
        return None, 0

    name = os.environ.get("STUDYDECK_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
    try:
        tok = AutoTokenizer.from_pretrained(name, local_files_only=True)
        mdl = AutoModel.from_pretrained(name, local_files_only=True)
        mdl.eval()
        dim = int(mdl.config.hidden_size)
        return (tok, mdl, dim), dim
    except Exception as e:
        # local_files_only=True：**不允许联网**。宁可降级到哈希，
        # 也不要让一次检索卡在下载上（用户会以为整个系统卡死了）。
        _ERR = "模型没缓存：%s" % str(e)[:120]
        return None, 0


def backend():
    """当前用哪个后端。第一次调用时决定，之后一直复用。

    整个探测过程加锁：并发进来的第二个请求会等第一个加载完，
    而不是自己去 import 一遍（那正是偶发降级的来源）。
    """
    global _BACKEND, _MODEL, _DIM
    if _BACKEND is not None:
        return _BACKEND
    with _LOCK:
        if _BACKEND is not None:      # 等锁期间别人已经加载好了
            return _BACKEND
        m, dim = _try_bge()
        if m is not None:
            _MODEL, _DIM, _BACKEND = m, dim, "bge"
        else:
            _MODEL, _DIM, _BACKEND = None, HASH_DIM, "hash"
    return _BACKEND


def info():
    """给界面/调试看：现在用的是哪个后端、多少维、为什么降级。"""
    be = backend()
    return {"backend": be, "dim": _DIM,
            "model": "BAAI/bge-small-zh-v1.5" if be == "bge" else "hash-ngram",
            "fallback_reason": _ERR if be == "hash" else ""}


# ---------------- 哈希兜底 ----------------
HASH_DIM = 384
ENT_BASE = 256
ENT_SPAN = HASH_DIM - ENT_BASE


def _h(s: str, mod: int) -> int:
    """稳定哈希。用 blake2b 不用内置 hash()：后者每个进程加的盐不同，
    重启一次向量全变 —— 那等于每次重启都要重算整个库。"""
    d = hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(d, "big") % mod


def _encode_hash(text: str):
    t = str(text or "").strip().lower()
    if not t:
        return [0.0] * HASH_DIM
    vec = [0.0] * HASH_DIM
    cs = [c for c in t if not c.isspace()]
    for n in (1, 2, 3):
        for i in range(0, max(0, len(cs) - n + 1)):
            g = "".join(cs[i:i + n])
            vec[_h("c%d:%s" % (n, g), ENT_BASE)] += 1.0 / n
    for w in re.split(r"[\s,，。、；：!?？!()（）\[\]【】/\\|]+", t):
        if len(w) >= 2:
            vec[_h("w:" + w, ENT_BASE)] += 1.6
    try:
        from .memories import extract_entities
        for e in extract_entities(t):
            if e:
                vec[ENT_BASE + _h("e:" + e, ENT_SPAN)] += 3.0
    except Exception as _e:
        _silent.log_squash(__name__, _e)
    n = math.sqrt(sum(x * x for x in vec))
    return [x / n for x in vec] if n > 0 else vec


# ---------------- 对外接口 ----------------
def encode(text: str):
    """文本 → 归一化向量。维度取决于后端（bge 512 / hash 384）。"""
    t = str(text or "").strip()
    be = backend()
    if be == "hash":
        return _encode_hash(t)
    if not t:
        return _zeros(_DIM)
    try:
        import torch
        tok, mdl, _ = _MODEL
        # bge 的惯例：检索类任务对 query 加这个前缀，效果明显更好
        # （模型训练时就是这么区分的，不加等于用错模式）。
        with torch.no_grad():
            batch = tok([t], padding=True, truncation=True,
                        max_length=256, return_tensors="pt")
            out = mdl(**batch)
            # CLS pooling：bge 系列用首个 token 的隐状态做句向量
            v = out.last_hidden_state[:, 0]
            v = torch.nn.functional.normalize(v, p=2, dim=1)
        return v[0].numpy()
    except Exception:
        # 运行中出任何意外都不许让检索挂掉 —— 退回哈希，这一条照样能检索
        return _encode_hash(t)


def encode_query(text: str):
    """查询用的编码。bge 建议 query 加指令前缀、文档不加，
    这样同一条记忆和问它的不同说法能在同一个空间里对上。"""
    t = str(text or "").strip()
    if backend() == "bge" and t:
        return encode("为这个句子生成表示以用于检索相关文章：" + t)
    return encode(t)


def _zeros(dim):
    try:
        import numpy as np
        return np.zeros(dim, dtype="float32")
    except Exception:
        return [0.0] * dim


def dim() -> int:
    return _DIM if _BACKEND else (backend() and _DIM) or HASH_DIM


def to_blob(vec) -> bytes:
    """存库：float32 小端。bge 512 维 = 2048 字节。"""
    try:
        import numpy as np
        return np.asarray(vec, dtype="float32").tobytes()
    except Exception:
        import struct
        return b"".join(struct.pack("<f", float(x)) for x in vec)


def from_blob(b):
    """读库。长度对不上就返回 None —— 调用方据此重算并回填。

    为什么要按长度判断而不是按配置：换了后端（hash→bge）之后，
    旧向量的维度跟新维度不同，混在一起算点积会直接报错。
    「长度不对就当没有」是最省事也最稳的处理。
    """
    if not b:
        return None
    try:
        try:
            import numpy as np
            a = np.frombuffer(b, dtype="float32")
            return a if a.size == dim() else None
        except Exception:
            import struct
            n = len(b) // 4
            if n != dim():
                return None
            return list(struct.unpack("<%df" % n, b))
    except Exception:
        return None


def cosine(a, b) -> float:
    """余弦相似度。两边都已归一化，所以就是点积。"""
    if a is None or b is None:
        return 0.0
    try:
        try:
            import numpy as np
            return float(np.dot(a, b))
        except Exception:
            return float(sum(x * y for x, y in zip(a, b)))
    except Exception:
        return 0.0
