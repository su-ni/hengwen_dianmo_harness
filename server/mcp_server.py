# -*- coding: utf-8 -*-
"""MCP server —— 把本机 210 个工具按 Model Context Protocol 暴露出去。

用户要求：「不要用多种逻辑去做同一件事」。所以这里**不重写任何工具**：
每一行都是把 REGISTRY 里已有的工具翻译成 MCP 的 tools/list 形状，
调用时直接走 tools.call()，权限、审计、工作区过滤全部沿用现成的。

协议（依据官方 spec 2025-11-25）：
  transport  stdio（每行一个 JSON-RPC 2.0 消息）
  methods    initialize / tools/list / tools/call / ping / notifications/*
  响应形状    {"jsonrpc":"2.0","id":N,"result":{...}}

**stdio 的硬规矩**：stdout 只能写 JSON-RPC，一个字节的多余输出都会毁掉协议。
所以这个模块里所有的日志/报错一律走 stderr（print(..., file=sys.stderr)）。

启动（给 Claude Desktop / Cline / 任意 MCP 客户端）：
    python -m server.mcp_server

客户端配置示例：
    {
      "mcpServers": {
        "hengwen-dianmo": {
          "command": "python",
          "args": ["-m", "server.mcp_server"],
          "cwd": "F:/path/to/衡文点墨harness"
        }
      }
    }
"""
from __future__ import annotations

import json
import os
import sys
import traceback

# 允许直接 python server/mcp_server.py 也能跑（补上包搜索路径）
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from server import tools as T  # noqa: E402

PROTOCOL_VERSION = "2025-11-25"
SERVER_NAME = "hengwen-dianmo-harness"
SERVER_VERSION = "0.9.0"


def log(msg):
    """stdout 是协议通道，日志只能走 stderr。"""
    print("[mcp] %s" % msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- schema 转换
# 我们的工具没有 JSON Schema 声明——参数靠函数签名 + **kwargs 收。
# MCP 要求 inputSchema，所以从签名反推一个**宽松但正确**的 schema：
#   有默认值的参数 → optional
#   必填参数       → required
# 类型一律给 string/number，并注明"按工具说明传"。宁可宽松，
# 也不要写出一个把正常调用挡在门外的严格 schema。
def _schema_of(fn):
    import inspect

    props = {}
    required = []
    try:
        sig = inspect.signature(fn)
    except Exception:
        return {"type": "object", "properties": {}, "additionalProperties": True}
    for name, p in sig.parameters.items():
        if name in ("self",):
            continue
        # **kwargs / *args 不进 schema（它们就是"其余参数"）
        if p.kind in (p.VAR_KEYWORD, p.VAR_POSITIONAL):
            continue
        ann = p.annotation
        typ = "string"
        if ann in (int, float):
            typ = "number"
        elif ann is bool:
            typ = "boolean"
        default = p.default
        if default is inspect._empty:
            required.append(name)
            props[name] = {"type": typ}
        else:
            props[name] = {"type": typ, "default": default if isinstance(default, (str, int, float, bool)) else None}
            if props[name].get("default") is None:
                props[name].pop("default", None)
    s = {"type": "object", "properties": props, "additionalProperties": True}
    if required:
        s["required"] = required
    return s


def _tool_list():
    """把 REGISTRY 翻译成 MCP tools 数组。"""
    out = []
    for name, ent in sorted(T.REGISTRY.items()):
        desc = ent.get("desc") or ""
        # 权限档对 MCP 客户端也有意义：写盘工具要人确认，这里如实写进描述
        perm = ent.get("perm") or "local"
        if perm == "confirm":
            desc = desc + "（会写本机数据，需要人确认）"
        out.append({
            "name": name,
            "description": desc,
            "inputSchema": _schema_of(ent.get("fn")),
        })
    return out


# ---------------------------------------------------------------- JSON-RPC
def _ok(mid, result):
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def _err(mid, code, message, data=None):
    e = {"code": code, "message": message}
    if data is not None:
        e["data"] = data
    return {"jsonrpc": "2.0", "id": mid, "error": e}


def handle(req):
    """处理一条请求。返回响应 dict；通知类消息返回 None（不响应）。"""
    if not isinstance(req, dict):
        return _err(None, -32600, "Invalid Request")
    mid = req.get("id")
    method = req.get("method") or ""
    params = req.get("params") or {}

    # 通知（没有 id）不需要响应
    is_notification = "id" not in req

    try:
        if method == "initialize":
            r = _ok(mid, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": (
                    "衡文点墨 HARNESS：本机学习工作台。"
                    "这里暴露的是它真实的 %d 个工具，全部读写本机 SQLite 与文件。"
                    "写操作类工具需要用户确认；只读类可直接调用。" % len(T.REGISTRY)
                ),
            })
            return None if is_notification else r

        if method == "notifications/initialized":
            return None

        if method == "ping":
            return None if is_notification else _ok(mid, {})

        if method == "tools/list":
            tools = _tool_list()
            log("tools/list -> %d 个工具" % len(tools))
            return None if is_notification else _ok(mid, {"tools": tools})

        if method == "tools/call":
            name = params.get("name") or ""
            args = params.get("arguments") or {}
            if name not in T.REGISTRY:
                return _err(mid, -32602, "未知工具：%s" % name)
            # **复用现成的 call()**：权限、审计、工作区过滤、异常兜底全在里面
            r = T.call(name, args, confirmed=False)
            if r.get("need_confirm"):
                # MCP 没有"弹卡片"这一步，如实告诉客户端这一步需要人确认
                return _ok(mid, {
                    "content": [{"type": "text", "text":
                                 "这个工具会写本机数据，需要用户确认：%s\n参数：%s"
                                 % (name, json.dumps(args, ensure_ascii=False))}],
                    "isError": True,
                })
            ok = bool(r.get("ok"))
            body = r.get("data") if r.get("data") is not None else {"error": r.get("error")}
            return _ok(mid, {
                "content": [{"type": "text", "text": json.dumps(body, ensure_ascii=False, default=str)}],
                "isError": not ok,
            })

        # 其余（resources/prompts/logging 等）本项目不提供，按协议回"不支持"
        if is_notification:
            return None
        return _err(mid, -32601, "Method not found: %s" % method)
    except Exception as e:
        log("处理失败 %s: %s" % (method, e))
        traceback.print_exc(file=sys.stderr)
        return None if is_notification else _err(mid, -32603, "内部错误：%s" % str(e)[:200])


def main():
    log("启动：%s v%s（工具 %d 个）" % (SERVER_NAME, SERVER_VERSION, len(T.REGISTRY)))
    # 预热 embed 之类不要做：MCP 客户端可能只想列工具，别让它等模型加载
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            out = _err(None, -32700, "Parse error")
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        # 批量请求
        if isinstance(req, list):
            resps = [handle(x) for x in req]
            resps = [r for r in resps if r is not None]
            if resps:
                sys.stdout.write(json.dumps(resps, ensure_ascii=False) + "\n")
                sys.stdout.flush()
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    log("stdin 关闭，退出")


if __name__ == "__main__":
    main()
