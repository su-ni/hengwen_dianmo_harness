# 衡文点墨 HARNESS

本机优先的 AI 学习工作台。前端是界面层，后端是 AI 接入层与本机数据层：Agent 通过工具注册表直接读写本机的课程、题库、笔记与计划，SSE 流式驱动交互，全部数据落在本机 SQLite。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript（strict）+ Vite 7，路由用 hash，页面级 `React.lazy` 分包 |
| 后端 | Python 3.11+ / FastAPI + Uvicorn，同步工具调用走线程池 |
| 存储 | SQLite（29 张表），WAL 模式，单文件 `data/study.db` |
| 流式 | SSE（`/api/agent/stream`），分帧协议 `data: {json}\n\n` |
| 向量 | `BAAI/bge-small-zh-v1.5`（512 维，本地推理，无外部 embedding 服务） |
| 调度 | FSRS 6.x（间隔重复），学习步长按天 |
| 绘图 | Canvas 2D（光环引擎）、ReactFlow（导图编辑器） |

## 运行

```bash
pip install -r requirements.txt

cp server/config.example.json server/config.local.json   # 填模型 Key（该文件已被 .gitignore 排除）
cd app && npm install && npm run build                   # 产物输出 web/app-dist/
python -m server.main                                    # 或 start.bat
# http://127.0.0.1:8770
```

开发模式：`cd app && npm run dev`（Vite 5173，`/api` 代理到 8770）。

## 目录

```
server/                 FastAPI 后端
  main.py               入口、路由、静态挂载
  agent.py              Agent 循环（多轮工具编排 + 流式事件）
  tools.py              工具注册表（209 个，@tool 装饰器）
  store.py              SQLite 数据层
  datahub.py            数据中枢（课程/题库/讲次装配）
  memories.py           记忆：五类、向量召回、三层分层、过期纠正
  mastery.py            熟练度：FSRS 调度 + 训练样本
  judge.py              判断小模型（逻辑回归，含激活闸）
  embed.py              本地语义向量封装
  extract.py            写时记忆抽取规则
  layers.py             core / recall / archival 分层判定
  prompts.py            系统提示词
  silent.py             静默异常留痕（默认关闭）
  seed_train.py         训练样本生成（真数据 + 标记合成）

app/src/
  pages/                页面（每页一个 lazy chunk）
  pages/halo/           光环控制台：engine / panels / feed / tuner / memoryfield
  pages/canvas/         导图编辑器：节点、自动布局、导出
  components/           通用组件（Shell / Chat / V6 设计系统 / 气泡 / 命令面板）
  lib/                  SSE 传输层、工具调用、格式化、录制

web/                    静态资源与构建产物
  app-dist/             React 构建输出（后端挂 `/app/`）
  halo/                 上游 HALOFLUX 原始资产（含 LICENSE）

data/                   运行数据（SQLite、凭据、备份），不入库
docs/                   开发文档，不入库
regress.py              一键回归脚本
```

## 功能

### 对话与工具编排

- **209 个工具**，20 个分组，全部可被模型调用；写盘类工具带权限档（只读 / 先问 / 完全信任）与二次确认
- **SSE 流式**：逐 token 推送，事件类型 `token / think / tool / step / run / substep / memory / retract / end`
- **思考可视化**：`think` 与工具调用交错成时间线，刷新后按序复原
- **操作卡**：工具返回结构化卡片（课程候选、入库确认、计划文档），可点按执行
- **撤回重答**：模型输出被判为不可信时发 `retract`，前端清空当前气泡重新接收
- **上下文压缩**：按 token 预算裁剪历史，折叠记录可查
- **并行工具**：只读工具并发执行，写盘工具串行等待确认

### 记忆系统

- **五类记忆**：偏好 / 事实 / 困难点 / 目标 / 变更（另有"洞察"作为第六类）
- **写时抽取**：用户发言当下即时落库，规则来自 `extract.py`（疑问句、否定句、纠正句式均有拦截）
- **按需检索**：模型自己决定何时调 `memory_recall`，不做静态注入；检索为向量 + 关键词 + 实体 + 时间四路融合
- **三层分层**：`core`（常驻）/ `recall`（近期）/ `archival`（归档），纯函数判定，可预演未来分层
- **过期纠正**：新说法顶掉旧说法（`valid_to` 封存，不删），保留 `refines` 边可查历史
- **本地向量**：bge-small-zh 512 维，无网络依赖；模型缺失时降级为哈希 n-gram

### 判断模型

- **FSRS 调度**：决定"下次什么时候复习"，学习步长按天（1 / 3 / 7 天起步，60 天封顶）
- **熟练度**：0–1 分值 + 一句人话理由（正确率、最近一次、耗时、犹豫次数四信号）
- **自建小模型**：逻辑回归，7 维特征；样本不足 30 条时拒绝训练
- **激活闸**：训练出的权重默认只存档，`predict` 仍走规则；需显式激活才接管判分
- **样本采集**：每次作答自动落一条训练样本，标注来源（真实 / 合成）

### 学习功能

| 模块 | 能力 |
|---|---|
| 课程 | B 站课程搜索、分集核对、入库成讲次；播放进度落库 |
| 课堂 | 视频 + 时间轴截图 + 当堂提问 + 笔记（按讲次存） |
| 背单词 | SM-2 词盒 + 百词斩词书拉取、错词本、生词本、复习队列 |
| 刷题 | 题源分组、判分、错因标签、按弱项出题 |
| 真题卷 | 卷子导入与解析、按题型权重算分、交卷记录 |
| 讲题 | 四段式讲解（定位 / 依据 / 判断 / 纠错），依据需通过复核 |
| 作文 | 真题作文题单、本机可算项判分 |
| 计划 | 考试日期与每日时长预算、按讲次排课、今日编排 |
| 画布 | ReactFlow 导图，XMind / Obsidian / Markdown 导入导出 |
| 截图库 | 视频截帧、标注、标签、按讲次时间线 |
| 统计 | 讲次 / 词 / 作答 / 打卡 / 熟练度分布 |

### 光环控制台（HARNESS）

整屏可视化，两副面孔：

- **运行时**：节拍驱动的五层光束、圆环数据块、飞出流线、雾带、自动运镜、辉光合成；数据块数值取自真实统计（记忆数 / 关联数 / 工具数 / 向量覆盖 / 分层计数）
- **记忆场**：横向时间轴 × 类型泳道，点任意一条看内容与时间
- **调参面板**：56 个引擎参数分 6 组，拖动实时生效，不重建引擎，可一键复位

底部 8 块面板：工具流水、对流粒子、方法工作区、计划差分、记忆来源、校验缓冲、子智能体派发（按真实工具调用聚合）、三层与向量覆盖。

### 工作区

每次学习任务一个工作区，科目、会话、计划、记忆、熟练度全员隔离；支持归档、导出 zip、迁移历史数据。

### 其他

- **气泡**：跨工作区状态点，任务跑完或等你回答时提示，就地可答
- **技能**：`skills/` 下的 SKILL.md 按需加载进上下文
- **模式**：标准 / 计划（只读，写操作被闸住）/ 自动
- **备份同步**：本机备份与恢复、多机同步包
- **语音输入**：本机 ASR（模型按需安装，转写在本机完成）

## HTTP 接口

| 类型 | 路径 | 说明 |
|---|---|---|
| SSE | `POST /api/agent/stream` | 对话流式响应 |
| REST | `GET /api/base` | 启动数据（科目、工作区、统计） |
| REST | `POST /api/tool/{name}` | 调用单个工具 |
| SSE | `POST /api/tool/{name}/run` | 调用工具并推送过程 |
| REST | `GET /api/memories` | 记忆列表 + 统计 |
| REST | `GET /api/mastery` | 熟练度概览 / 到期列表 |
| REST | `GET /api/tools` | 工具清单 + 最近调用 |

## 开一个空白实例

同一份代码、同一份前端产物，只换数据目录与端口（用于演示或隔离测试）：

```json
// 仓库外任意位置，如 _demo/config.json
{ "APP_DATA_DIR": "…/data-demo", "PORT": 8771, "HOST": "127.0.0.1" }
```

```bash
# Windows PowerShell
$env:MDSA_CONFIG='…\_demo\config.json'; python -m server.main
# 访问 http://127.0.0.1:8771/app/
```

空白实例的数据库、凭据、备份全部落在自己的 `APP_DATA_DIR`，与正式库完全隔离。

## 环境变量

| 变量 | 作用 |
|---|---|
| `MDSA_CONFIG` | 指向另一份配置 json，覆盖数据目录与端口（开空白实例） |
| `STUDYDECK_SILENT_LOG=1` | 输出被有意吞掉的异常（模块 / 行号 / 类型），用于排查 |

## MCP 支持

210 个工具同时以 **Model Context Protocol** 暴露，可被 Claude Desktop、Cline、任意 MCP 客户端调用：

```bash
python -m server.mcp_server        # stdio 传输，JSON-RPC 2.0
```

客户端配置：

```json
{
  "mcpServers": {
    "hengwen-dianmo": {
      "command": "python",
      "args": ["-m", "server.mcp_server"],
      "cwd": "/path/to/hengwen-dianmo-harness"
    }
  }
}
```

协议版本 `2025-11-25`，支持 `initialize` / `tools/list` / `tools/call` / `ping`。
**不重写任何工具**：每一项都是把已有工具翻译成 MCP 形状，调用走同一个 `tools.call()`，
权限、审计、工作区过滤全部沿用。

## 回归测试

```bash
python regress.py
```

29 项断言，覆盖：Python 语法、模块导入与循环依赖、工具注册表、记忆接口与字段名、三层与向量、判断模型状态与激活闸、计划模式只读闸、静默日志设施、数据层封装、前端构建。不写脏数据（唯一写操作在计划模式下被闸住）。

## 数据与隐私

- 课程、题库、记忆、熟练度、会话、作答记录**全部在本机** `data/study.db`
- 模型密钥存 `server/config.local.json` 与 `data/ai_cred/`，二者均在 `.gitignore` 中
- 语义向量在本机推理，不外发文本
- 仓库不包含任何运行数据、凭据或个人记录

## 许可

个人项目，仅限学习交流使用。

光环控制台的视觉源头为 HALOFLUX（作者 Ryder191），采用 PolyForm Noncommercial 1.0.0 授权；原始声明与 LICENSE 保留于 `web/halo/`。
