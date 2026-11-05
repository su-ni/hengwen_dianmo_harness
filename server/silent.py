# -*- coding: utf-8 -*-
"""静默异常的可观测化（第 ③ 项，上帝代码收拾）。

项目里有 144 处 `except Exception: pass`。它们**大多是有意的** ——
比如「探测一下这个可选字段在不在」「模型没配就跳过」，失败本就该被忽略。
问题不在于「吞掉」，而在于**吞掉之后什么都没留下**：
排查时只能靠猜，这次 D37「say 说排了 2 项但 rows 是空」就吃了这个亏。

所以不动逻辑，只加一行日志：
    原来  except Exception:
              pass
    现在  except Exception as e:
              _silent(locals(), e)          # 或者 log_squash(__name__, e)

**为什么不用 logging 直接打全栈**：
144 处里很多在热路径上（每帧、每次工具调用），全栈日志会把磁盘写爆。
这里只记 模块 + 行号 + 异常类型 + 一句话，且默认 DEBUG 级
（`STUDYDECK_SILENT_LOG=1` 才真正输出），平时零开销。

**为什么不是上下文管理器**：144 处逐个套 with 改动面太大，
而且很多 except 里除了 pass 还有别的事。直接提供一个函数调用最简单，
调用方一行替换即可，行为完全不变。
"""
from __future__ import annotations

import os
import sys
import traceback

_ENABLED = os.environ.get("STUDYDECK_SILENT_LOG", "").strip().lower() in ("1", "true", "yes")
_LOG = None


def _get_log():
    global _LOG
    if _LOG is None:
        try:
            import logging
            _LOG = logging.getLogger("studydeck.silent")
            if not _LOG.handlers:
                h = logging.StreamHandler(sys.stderr)
                h.setFormatter(logging.Formatter("[silent] %(message)s"))
                _LOG.addHandler(h)
            _LOG.setLevel(logging.DEBUG)
        except Exception:
            _LOG = False
    return _LOG


def log_squash(module, exc, where=""):
    """记一次被有意吞掉的异常。

    只在 STUDYDECK_SILENT_LOG=1 时输出 —— 平时这个函数就是一个布尔判断，
    不会拖慢热路径。要排查问题时开环境变量，就能看到「哪里吞了什么」。
    """
    if not _ENABLED:
        return
    lg = _get_log()
    if not lg:
        return
    try:
        tb = traceback.extract_tb(exc.__traceback__)
        frame = tb[-1] if tb else None
        loc = "%s:%s" % (frame.filename.split("\\")[-1], frame.lineno) if frame else "?"
        lg.debug("%s %s | %s: %s | %s", module, where, type(exc).__name__,
                 str(exc)[:120], loc)
    except Exception:
        pass


def squash(module, exc, where=""):
    """给 `except Exception as e:` 用的一行替换（语义等同于 pass）。"""
    log_squash(module, exc, where)
