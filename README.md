# 衡文点墨 HARNESS

AI Native 学习工作台。前端是界面，后端是 AI 接入层与本机数据层：Agent 通过工具注册表直接操作本机的课程、题库、笔记与计划，流式对话驱动，**数据只存本机**。

| | |
|---|---|
| 前端 | React 19 + TypeScript (strict) + Vite 7 |
| 后端 | Python 3.11+ / FastAPI + SQLite |
| 形态 | 单机 Web 应用（127.0.0.1:8770） |
| 工具 | 209 个（`server/tools.py` 装饰器注册） |
| 数据 | 29 张表，全在本机 `data/study.db` |

## 架构

```
┌────────────────── 前端（React 19 + TS strict，18 页）──────────────────┐
│ 课程主页 / 课堂 / 练习 / 考场 / 画布 / 截图库 / 全局搜索 / 助手        │
│ HARNESS 光环控制台（运行时 + 记忆场 + 56 参数调参）                     │
│ 统计页（熟练度 + 判断模型状态）· 气泡 · 设计系统                       │
│ 流式渲染（SSE）· 思考可视化 · 操作卡 · 响应式布局                      │
└───────────────────────────────┬───────────────────────────────┘
                                │ SSE /api/agent/stream · REST /api/tool/{name}
                                ▼
┌──────────────── AI 接入层（FastAPI）─────────────────┐
│ agent.py      Agent 循环：多轮工具编排、操作卡、按需检索记忆  │
│ tools.py      工具注册表（209 个，领域逻辑下沉到各模块）      │
│ memories.py   记忆：五类 / 向量 RAG / 三层 / 过期纠正         │
│ mastery.py    熟练度：FSRS 按天调度 + 训练样本采集             │
│ judge.py      自建判断小模型（样本不足时规则兜底）             │
│ embed.py      本地语义向量（bge-small-zh，无网络依赖）         │
│ layers.py     core / recall / archival 三层分层                │
│ model_router  模型出口路由、上下文压缩                         │
│ evidence.py   证据检索与引文核对                               │
│ store.py      SQLite 数据层                                    │
└──────────────────────────────────────────────────────────────┘
```

**数据只存本机**：记忆、熟练度、训练样本、课程、题库全在 `data/study.db`，不上传。

## 运行

```bash
pip install fastapi uvicorn fsrs

cp server/config.example.json server/config.local.json   # 填模型 Key

cd app && npm install && npm run build                   # 产物输出 web/app-dist/

python -m server.main                                    # 或双击 start.bat
# http://127.0.0.1:8770
```

## 开一个空白实例（演示用）

同一份代码、同一个 `web/app-dist`，只换数据目录和端口：

```json
// 仓库外任意位置，比如 _demo/config.json
{ "APP_DATA_DIR": "…/data-demo", "PORT": 8771, "HOST": "127.0.0.1" }
```

```bash
# Windows PowerShell
$env:MDSA_CONFIG='…\_demo\config.json'; python -m server.main
# 访问 http://127.0.0.1:8771/app/
```

空白实例不碰正式库：记忆、作答、会话、熟练度全在自己的 `data-demo` 里。

可选环境变量：

| 变量 | 作用 |
|---|---|
| `MDSA_CONFIG` | 指向另一份配置 json，开空白实例（换数据目录 + 端口） |
| `STUDYDECK_SILENT_LOG=1` | 输出被有意吞掉的异常（模块 / 行号 / 类型），排查用 |

## 回归测试

```bash
python regress.py        # 29 项：语法/模块/接口/记忆/模型/只读闸/日志/构建
```

跑之前确保 `python -m server.main` 起着。不写脏数据（唯一写操作在计划模式下被只读闸挡住）。

## 目录

```
app/src/pages/halo/     HARNESS 光环引擎（Canvas 2D 移植 + 调参面板）
app/src/pages/canvas/   导图编辑器（ReactFlow）
app/src/lib/            SSE 传输层、工具层、格式化
server/                 FastAPI 后端
web/halo/               上游 HALOFLUX 原始资产与 LICENSE
```

## 许可

个人项目，仅限学习交流使用。

视觉源头：`web/halo/` 内的 HALOFLUX 由 Ryder191 开发，PolyForm Noncommercial 1.0.0 授权，原始声明与 LICENSE 原样保留。
