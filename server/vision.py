# -*- coding: utf-8 -*-
"""图片 → 多模态消息。**不自己识别，交给模型。**

用户的要求很明确：模型本来就有视觉能力，直接把图发过去就行，
不要在本地建 OCR 那套东西。这里只做一件小事：

    本地图片路径  →  模型 API 认的 image_url / base64 content 数组

为什么单独一个模块而不是塞进 llm.py：
  两家上游（OpenAI 兼容 / WorkBuddy / Trae）都要用同一个转换，
  写成两遍迟早不一致。转一次，两边都用。

**尺寸必须压。** 一张 1920×1080 的 PNG 转 base64 有 2~3MB，
  塞进请求里会让模型那边直接 413 或者超时。这里统一压到长边 1280、
  JPEG 质量 0.85 —— 对"看清一道题"足够，体积降到 1/10。
"""
from __future__ import annotations

import base64
import io
import os

from . import config

# 长边上限与质量：够看清题干，又不会把请求撑爆
# 长边与质量。实测：1280/85 对「整页小字」辨认不准（把标题认错），
# 题目截图里的字通常比整页 UI 小字大，但也需要更清楚一些。
# 1600/90 在「看清题干」与「请求体积」之间更稳：一张 1080p 截图约 150~250KB。
MAX_SIDE = 1600
JPEG_Q = 90
MAX_BYTES = 6 * 1024 * 1024      # 压完还超 6MB 就如实拒绝，不硬塞


def _read_bytes(path):
    """读本地图片。只允许在应用目录内 —— 和 fs_read 同一条规矩。"""
    p = os.path.abspath(path)
    root = os.path.abspath(config.APP_DIR)
    if not (p == root or p.startswith(root + os.sep)):
        return None, "只读应用目录内的图片：%s" % path
    if not os.path.exists(p):
        return None, "文件不存在：%s" % path
    try:
        with open(p, "rb") as f:
            return f.read(), None
    except Exception as e:
        return None, "读不了：%s" % str(e)[:100]


def to_data_url(path):
    """本地图片 → data URL（已压缩）。返回 (url, err)。"""
    raw, err = _read_bytes(path)
    if err:
        return None, err
    try:
        from PIL import Image
    except Exception:
        # 没有 Pillow：原样 base64（可能是 PNG，体积大但能发）
        if len(raw) > MAX_BYTES:
            return None, "图片 %d KB 且本机没有 Pillow 压不了，超过上限" % (len(raw) // 1024)
        ext = os.path.splitext(path)[1].lower().lstrip(".") or "png"
        mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/" + ext
        return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode()), None
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        w, h = im.size
        long_side = max(w, h)
        if long_side > MAX_SIDE:
            k = MAX_SIDE / float(long_side)
            im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=JPEG_Q, optimize=True)
        data = buf.getvalue()
        if len(data) > MAX_BYTES:
            return None, "压完还有 %d KB，超过 %d KB 上限" % (len(data) // 1024, MAX_BYTES // 1024)
        return "data:image/jpeg;base64," + base64.b64encode(data).decode(), None
    except Exception as e:
        return None, "图片处理失败：%s" % str(e)[:100]


def user_content(text, images=None):
    """把「一句话 + 若干图片路径」组成模型认的 content。

    没有图片时**返回纯字符串** —— 不是所有上游都接受数组形式，
    纯文本场景保持原样最安全。
    """
    paths = [x for x in (images or []) if x]
    if not paths:
        return text, []
    parts = [{"type": "text", "text": text or "看看这些图"}]
    errors = []
    for p in paths[:4]:                 # 一次最多 4 张，再多请求会过大
        url, err = to_data_url(p)
        if err:
            errors.append("%s：%s" % (os.path.basename(p), err))
            continue
        parts.append({"type": "image_url", "image_url": {"url": url}})
    if not any(x.get("type") == "image_url" for x in parts):
        return text, errors             # 一张都没成：退回纯文本，把原因带回去
    return parts, errors
