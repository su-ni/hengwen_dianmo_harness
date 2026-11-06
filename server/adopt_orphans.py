# -*- coding: utf-8 -*-
"""把历史数据（workspace_id IS NULL）归到当前工作区。

为什么需要这个显式操作：这些数据在加列之前就存在，它们本来不属于任何工作区
（那时候根本没有「工作区隔离」这回事）。自动回填会把归属关系永久搞错，
所以做成一个用户主动点的按钮，且只做一次。
"""
import os
import sys

# 从本文件位置推仓库根，不写死本机绝对路径 —— 那会把「某台机器上的目录结构」
# 带进公开仓库，换机器就报错，也泄露了本机布局。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from server import store

def adopt(workspace_id=None):
    wid = workspace_id or store.ws_now()
    if not wid:
        return {"ok": False, "error": "没有当前工作区"}
    tables = ("answers", "word_mem", "notes", "canvas_maps",
              "shots", "lesson_progress", "events", "sessions")
    out = {}
    con = store.connect()
    try:
        for t in tables:
            try:
                cur = con.execute(
                    "UPDATE %s SET workspace_id=? WHERE workspace_id IS NULL" % t,
                    (wid,))
                out[t] = cur.rowcount
            except Exception as e:
                out[t] = "skip: %s" % str(e)[:40]
        con.commit()
    finally:
        con.close()
    return {"ok": True, "workspace_id": wid, "adopted": out}


if __name__ == "__main__":
    print(adopt())
