# -*- coding: utf-8 -*-
"""技能系统：`skills/<name>/SKILL.md` 的扫描、解析与按需加载。

跟「插件」不是一回事（这点容易混，写清）：
  · **技能** = 一份 Markdown 指令集。模型平时只看得到 `name` + `description`，
    觉得用得上才把正文读进来。它教模型「怎么做」。
  · 插件 = 带 `apply(ctx)` 的代码包，扩展的是能力本身。

目录约定（照 DeepSeek Harness 那套）：
    <项目>/skills/<name>/SKILL.md
    <项目>/skills/<name>.md          （扁平写法也认）

frontmatter 最小集：
    name: kebab-case，唯一
    description: 模型唯一能看到的「什么时候该用我」，写得含糊就等于不存在
    whenToUse: 可选，补充指引
    user-invocable: 默认 true（人能手动调用）
    disable-model-invocation: 默认 false（true = 模型看不到，只能人手动叫）
"""
from __future__ import annotations

import os
import re

# 项目根：本文件在 server/ 下，往上一层就是项目根
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILLS_DIR = os.path.join(_ROOT, "skills")

_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _parse_front(text):
    """解析 `---` 包起来的 frontmatter。没写就当空。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta = {}
    for line in head.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if v.lower() in ("true", "false"):
            meta[k] = (v.lower() == "true")
        else:
            meta[k] = v
    return meta, body


def _read(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def discover():
    """扫出所有技能。按 name 去重（先扫到的赢）。"""
    out = {}
    if not os.path.isdir(SKILLS_DIR):
        return []
    try:
        entries = sorted(os.listdir(SKILLS_DIR))
    except Exception:
        return []

    for name in entries:
        if name.startswith("."):
            continue
        p = os.path.join(SKILLS_DIR, name)
        path = None
        if os.path.isdir(p):
            cand = os.path.join(p, "SKILL.md")
            if os.path.isfile(cand):
                path = cand
        elif name.lower().endswith(".md"):
            path = p
        if not path:
            continue

        raw = _read(path)
        if not raw.strip():
            continue
        meta, body = _parse_front(raw)
        sk_name = str(meta.get("name") or (name[:-3] if name.endswith(".md") else name)).strip()
        if not _NAME_RE.match(sk_name):
            continue                       # 名字不合规的直接跳过，不猜
        desc = str(meta.get("description") or "").strip()
        if not desc:
            # description 是模型唯一的路由信息，没有就等于模型永远用不上它
            continue
        out[sk_name] = {
            "name": sk_name,
            "description": desc,
            "when": str(meta.get("whenToUse") or meta.get("when_to_use") or "").strip(),
            "user_invocable": meta.get("user-invocable", True) is not False,
            "model_can": meta.get("disable-model-invocation", False) is not True,
            "path": path,
            "body": body,
        }
    return [out[k] for k in sorted(out)]


def catalog():
    """模型看得到的目录：只给名字和「什么时候用」，不给正文、不给路径。"""
    items = []
    for s in discover():
        if not s["model_can"]:
            continue
        items.append({"name": s["name"], "description": s["description"],
                      "whenToUse": s["when"]})
    return items


def load(name):
    """按名字取正文（模型决定要用时调）。"""
    for s in discover():
        if s["name"] == name:
            return s
    return None


def list_public():
    """给界面看的完整列表（含正文预览，方便人判断要不要开）。"""
    out = []
    for s in discover():
        out.append({
            "name": s["name"],
            "description": s["description"],
            "whenToUse": s["when"],
            "userInvocable": s["user_invocable"],
            "modelCan": s["model_can"],
            "chars": len(s["body"] or ""),
            "preview": (s["body"] or "")[:400],
        })
    return out
