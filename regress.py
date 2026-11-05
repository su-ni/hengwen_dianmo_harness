# -*- coding: utf-8 -*-
"""研学台 · 一键回归（可重复运行，不写脏数据）。

为什么要有这个文件：以前每次验证都是临时 _t_*.py，跑完就删，
下次又得重写一遍，而且每个人写的断言口径都不一样。
这里把「验证这台机器还好着」固化成一个命令：

    python regress.py

覆盖：Python 语法 / 模块导入 / 工具注册表 / 接口 / 记忆 / 判断模型 /
      计划模式只读闸 / 静默日志设施 / 前端构建 / 路由冒烟(可选)。

**不写脏数据**：只调只读接口；唯一会写的是计划模式闸的验证，
而它在 plan 模式下必被挡住，所以什么都不会落库。
"""
from __future__ import annotations

import io
import sys

# Windows 控制台默认 GBK，中文断言名会变成乱码。
# 强制 UTF-8 输出（errors=replace 保证管道/重定向时也不炸）。
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

import ast
import glob
import json
import os
import subprocess
import sys
import urllib.request

API = "http://127.0.0.1:8770"
ROOT = os.path.dirname(os.path.abspath(__file__))
PASS = 0
FAIL = 0


def ok(cond, label, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  PASS", label)
    else:
        FAIL += 1
        print("  FAIL", label, extra)


def tool(name, args=None):
    body = json.dumps({"args": args or {}}).encode("utf-8")
    req = urllib.request.Request(API + "/api/tool/" + name, data=body,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30)).get("data")


def get(path):
    return json.load(urllib.request.urlopen(API + path, timeout=30))


def post(path, obj):
    req = urllib.request.Request(API + path,
                                 data=json.dumps(obj).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=20).read()


def section(t):
    print()
    print("===", t, "===")


def main():
    os.chdir(ROOT)

    # ---- 0) 服务活着 ----
    section("服务")
    try:
        ok(get("/api/base").get("ok") is not False, "/api/base 200")
    except Exception as e:
        ok(False, "/api/base", str(e))
        print("后端没起，后面全跳过。先 python -m server.main")
        return 1

    # ---- 1) Python 语法 ----
    section("Python 语法")
    files = sorted(glob.glob("server/*.py"))
    bad = []
    for f in files:
        try:
            ast.parse(open(f, encoding="utf-8", errors="replace").read())
        except Exception as e:
            bad.append((f, str(e)))
    ok(not bad, "%d 个 server/*.py 语法" % len(files), bad)

    # ---- 2) 模块导入（含循环依赖检查）----
    section("模块导入")
    try:
        sys.path.insert(0, ".")
        from server import tools as T, agent, memories, mastery, judge, layers, extract, embed, silent, prompts
        ok(len(T.REGISTRY) == 208, "工具注册表 208 个", len(T.REGISTRY))
        ok(len(prompts.SYS) == 6475, "SYS 提示词完整", len(prompts.SYS))
        ok("%CATALOG%" in prompts.SYS, "CATALOG 占位符在")
        # 惰性代理：agent.xxx 访问要能拿到真实模块
        ok(T.agent.info().get("ok") is True, "tools.agent 惰性代理可用")
        ok(agent.info().get("ok") is True, "agent.info 可用")
    except Exception as e:
        ok(False, "模块导入", str(e))

    # ---- 3) 记忆系统 ----
    section("记忆系统")
    try:
        d = get("/api/memories")
        ok(d.get("ok") is True, "memories 200")
        s = d.get("stats", {})
        ok(s.get("total") == 10, "记忆 10 条", s.get("total"))
        ok(s.get("vector", {}).get("backend") == "bge", "向量后端 bge")
        ok(set(s.get("layers", {}).keys()) == {"core", "recall", "archival"}, "三层齐全")
        ok("insight" in [k["k"] for k in s.get("kinds", [])], "insight 已收编")
        ok("memories" in tool("memory_recall", {"q": "我的弱项"}), "recall 字段名 memories")
        ok("memories" in tool("memory_search", {"q": "作息"}), "search 字段名 memories")
    except Exception as e:
        ok(False, "记忆接口", str(e))

    # ---- 4) 判断模型 ----
    section("判断模型")
    try:
        j = tool("judge_status")
        ok(j.get("src") == "rule", "如实报规则估分", j.get("src"))
        ok(j.get("min_samples") == 30, "训练阈值 30")
        m = get("/api/mastery")
        ok(m.get("ok") is True, "mastery 200")
        # 按天调度：新条目第一次答对应该排「明天」
        ok(judge.status().get("ready") is False, "样本不足时不假装训练好了")
    except Exception as e:
        ok(False, "判断模型接口", str(e))

    # ---- 5) 计划模式只读闸（不落库）----
    section("计划模式只读闸")
    try:
        post("/api/mode", {"mode": "plan"})
        r = tool("memory_add", {"text": "回归探针不该被记住"})
        ok(not r.get("ok"), "plan 模式挡住写记忆", r)
        post("/api/mode", {"mode": "standard"})
        ok(get("/api/memories").get("stats", {}).get("total") == 10, "没写脏数据")
    except Exception as e:
        ok(False, "计划模式", str(e))
        try: post("/api/mode", {"mode": "standard"})
        except Exception: pass

    # ---- 6) 静默日志设施 ----
    section("静默日志")
    try:
        ok(silent._ENABLED is False, "默认关闭（零开销）")
        silent._ENABLED = True
        try:
            raise ValueError("regress")
        except ValueError as e:
            silent.log_squash("regress", e, "selftest")
        silent._ENABLED = False
        ok(True, "log_squash 可调用")
    except Exception as e:
        ok(False, "silent", str(e))

    # ---- 7) 数据层收归 ----
    section("数据层")
    try:
        from server import store
        ok(store.workspace_subjects(None) is None, "workspace_subjects(None)=None")
        ok(isinstance(store.workspace_subjects("__no_such_ws__"), set), "不存在的工作区返回空 set")
        ok(store.queue_words_for_today([]) == (0, 0), "queue_words_for_today 空入队")
    except Exception as e:
        ok(False, "数据层", str(e))

    # ---- 8) 前端构建 ----
    section("前端构建")
    try:
        r = subprocess.run(["npm", "run", "build"], cwd=os.path.join(ROOT, "app"),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=180, shell=True)
        # Windows 上 npm 输出是 GBK / 且某个流可能是 None，别用 text=True 硬解码
        out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
        ok(r.returncode == 0, "npm run build", out[-300:])
    except Exception as e:
        ok(False, "npm build", str(e))

    print()
    print("==== 回归结果: 通过 %d / 失败 %d ====" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())