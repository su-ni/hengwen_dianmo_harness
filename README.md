# 研学台 StudyDeck

AI Native 学习工作台。前端是界面，后端是 AI 接入层与本机数据层：Agent 通过工具注册表直接操作本机的课程、题库、笔记与计划，流式对话驱动，数据只存本机。

| | |
|---|---|
| 前端 | React 18 + TypeScript (strict) + Vite |
| 后端 | Python 3.11+ / FastAPI + SQLite |
| 形态 | 单机 Web 应用（127.0.0.1:8770） |

## 架构

```
┌───────────────────── 前端（React 18 + TS strict，16 页）─────────────────────┐
│ 课程主页 / 课堂 / 练习 / 考场 / 画布（自研导图引擎）/ 截图库 / 全局搜索 / 助手 │
│ 流式渲染（SSE）· 思考可视化 · 操作卡 · 设计系统 · 响应式布局                  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ SSE /api/agent/stream · REST /api/tool/{name}
                                 ▼
┌───────────────── AI 接入层（FastAPI）─────────────────┐
│ agent.py      Agent 循环：多轮工具编排、操作卡          │
│ tools.py      工具注册表（186 个，装饰器注册）           │
│ model_router  模型出口路由、上下文压缩                   │
│ evidence.py   证据检索与引文核对                        │
│ store.py      SQLite 数据层（20 张表）                   │
└───────────────────────────────────────────────────────┘
```

## 运行

```bash
pip install fastapi uvicorn

cp server/config.example.json server/config.local.json   # 填模型 Key

cd app && npm install && npm run build                   # 产物输出 web/app-dist/

python -m server.main                                    # 或双击 start.bat
# http://127.0.0.1:8770
```

## 目录

```
app/        前端源码（React + TS，Vite 构建到 ../web/app-dist）
server/     FastAPI：agent / tools / model_router / evidence / store
web/        静态资源
```

## 开发文档

`docs/工作区与对话优先-开发文档.md` 是**本机文档，不进仓库**（`.gitignore` 的 `docs/` 规则，
见文件内注释）。它记着所有架构决策、踩坑记录与验证结果（附章一到十七）。

换机器时请从备份恢复，不要指望 clone 能拿到：

```
F:\项目\备考专升本\_bak-1105-1905-before-commit\   ← 最全（含 study.db + 可回滚补丁）
F:\项目\备考专升本\_bak-1105-1830-before-split\
F:\项目\备考专升本\_bak-src-1105-1740\             ← 纯源码
F:\项目\备考专升本\_bak-1105-1500\                 ← 含数据库一致性快照
```

## 回归测试

```bash
python regress.py        # 一键回归：语法/模块/接口/记忆/模型/只读闸/日志/构建，26 项
```

另有两份工作区隔离探针在本机 `tests/`（该目录按 `.gitignore` 不入库）：

```bash
node tests/probe_ws_isolation.mjs   # 8 项
node tests/probe_ws_full.mjs        # 30 项
```

跑之前确保 `python -m server.main` 起着。`regress.py` 不写脏数据
（唯一会写的验证走计划模式，必被只读闸挡住）。

## 许可

个人项目，仅限学习交流使用。
