/* ============================================================
   halo/feed.ts —— 把「它在干什么」翻译成「光」

   这一层是 haloflux 在研学台能站住脚的**唯一理由**。
   官方 lab.html 里那些数字是随机数：PAPERS 64、AGENTS 12、CFL = |u|Δt/Δx，
   全是画上去的装饰。我们这页不许这样 —— 用户的原话是
   「我们那个页面不是摆设，是真的可以看这个 Agent 在干什么」。

   所以这里的每一条光都有出处：
     · 工具调用      ← /api/tools?   的 recent（后端 tool_calls 审计表，真跑过的）
     · 正在跑/等你答 ← /api/bubbles   的 items（后端 bubbles 表，跨工作区）
     · 记忆          ← /api/memories 的 items / links / stats
   拿不到就**空着并说空着**，不编数字填满。空着这件事本身也是信息：
   「这台机器还没跑过东西」和「跑了一堆但没记住」是两种不同的状态。

   为什么轮询而不是 SSE：
   agent 的 SSE 只在那一条会话开着的时候才有连接；用户切到 haloflux 这页，
   原来那条流早就断了。要从「别的会话、别的工作区」里看见动静，
   只有查后端这两张表 —— 反正它们本来就是为跨工作区准备的（见 bubbles.py 开头）。
   ============================================================ */

import type { Star, StarLink, Stroke } from './engine'
import type { MemKind } from './theme'

export type MemRow = {
  id: string
  kind: string
  content: string
  entities?: string | null
  weight?: number
  hits?: number
  last_hit?: string | null
  created_at?: string
  updated_at?: string
  source?: string
  /** 后端算好的层（core / recall / archival），前端只显示不重算 */
  layer?: string
}

export type LinkRow = { from_id: string; to_id: string; relation?: string }

export type Bubble = {
  id: string
  title?: string
  state: string          // running / done / ask / error
  level?: string
  tools?: number
  last_tool?: string | null
  question?: string | null
  ws_name?: string | null
  ts?: number
  updated?: number
}

export type ToolCall = {
  id: number
  ts: string
  name: string
  perm?: string
  ok?: number
  ms?: number
  note?: string
}

export type MemLayers = { core: number; recall: number; archival: number }
export type MemVector = { covered: number; total: number; dim: number }

export type MemStats = {
  total?: number
  links?: number
  kinds?: { k: string; cn: string; n: number }[]
  /** Letta 三层分布：core 每轮都进系统提示，archival 只靠检索翻出来 */
  layers?: MemLayers
  /** 向量覆盖率：老数据在检索时回填，所以这个数会自己涨上去 */
  vector?: MemVector
}

export type Snapshot = {
  mems: MemRow[]
  links: LinkRow[]
  stats: MemStats
  bubbles: Bubble[]
  calls: ToolCall[]
  at: number
}

/* ---------- 形状约简：把网络上的「不确定」挡在这一层 ---------- */
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

export async function pull(): Promise<Snapshot> {
  const get = (u: string) => fetch(u, { headers: { 'Accept': 'application/json' } }).then((r) => r.json()).catch(() => null)
  const [mem, bub, tl] = await Promise.all([
    get('/api/memories'),
    get('/api/bubbles?only_current=0'),
    get('/api/tools'),
  ])
  return {
    mems: asArray<MemRow>(mem?.items),
    links: asArray<LinkRow>(mem?.links),
    stats: (mem?.stats || {}) as MemStats,
    bubbles: asArray<Bubble>(bub?.items),
    calls: asArray<ToolCall>(tl?.recent),
    at: Date.now(),
  }
}

/* ============================================================
   一、记忆 → 星图
   ============================================================ */

const VALID_KINDS: MemKind[] = ['pref', 'fact', 'difficulty', 'goal', 'change']

/* 星图布局：五类记忆各占一个扇区，同类里按时间排开。
   为什么不搞力导向：力导向每次刷新节点都会跳，用户刚看中的那颗会跑掉。
   「类型聚成扇区、同类型按时间外扩」是**稳定**的 —— 同一条记忆永远在同一个位置，
   刷新只加不改。这对「我在看我的记忆」这件事比好看更要紧。
   外圈 = 更旧，内圈 = 更新：越靠近圆心，越是刚发生的事。 */
export function layoutStars(mems: MemRow[]): Star[] {
  const buckets: Record<string, MemRow[]> = { pref: [], fact: [], difficulty: [], goal: [], change: [] }
  for (const m of mems) {
    const k = VALID_KINDS.includes(m.kind as MemKind) ? (m.kind as MemKind) : 'fact'
    buckets[k].push(m)
  }
  const out: Star[] = []
  KINDS_ORDER.forEach((kind, ki) => {
    const list = buckets[kind]
    if (!list.length) return
    // 同类型里：时间新的排前面（半径小），这样「刚记住的」永远贴着圆心
    const sorted = [...list].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    const baseA = -Math.PI / 2 + (ki / KINDS_ORDER.length) * Math.PI * 2
    const fan = (Math.PI * 2) / KINDS_ORDER.length * 0.86
    const n = sorted.length
    sorted.forEach((m, i) => {
      const t = n <= 1 ? 0.5 : i / (n - 1)
      const a = baseA + (t - 0.5) * fan
      const rad = 0.16 + 0.80 * (n <= 1 ? 0.5 : i / Math.max(1, n - 1))
      const w = clamp01((m.weight ?? 0.6) / 1.2)
      out.push({
        id: m.id,
        kind,
        a,
        rad: clamp01(rad + (hashStr(m.id) - 0.5) * 0.06),
        size: 0.55 + 0.85 * w + 0.25 * (String(m.content || '').length > 24 ? 1 : 0),
        label: m.content,
      })
    })
  })
  return out
}

const KINDS_ORDER: MemKind[] = ['goal', 'fact', 'difficulty', 'pref', 'change']

function clamp01(v: number) { return Math.max(0, Math.min(1, v)) }

/* 稳定的伪随机：同一条记忆永远是同一个偏移，刷新不跳 */
function hashStr(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 10000) / 10000
}

/* 边：后端给的 links 可能有两种写法（from/to 或 from_id/to_id），统一一下。
   没连上的记忆不该是孤岛 —— 同类型相邻的两颗补一条弱连线，
   让「它们属于同一类」这件事在图上看得见。 */
export function buildLinks(mems: MemRow[], raw: LinkRow[]): StarLink[] {
  const ids = new Set(mems.map((m) => m.id))
  const out: StarLink[] = []
  const seen = new Set<string>()
  for (const l of raw) {
    const a = (l as any).from ?? (l as any).from_id
    const b = (l as any).to ?? (l as any).to_id
    if (!a || !b || !ids.has(a) || !ids.has(b)) continue
    const k = a < b ? a + '|' + b : b + '|' + a
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ from: a, to: b, rel: (l as any).relation })
  }
  return out
}

/* ============================================================
   二、Agent 正在干什么 → 光环上的光
   ============================================================ */

/* 工具名 → 扇区角度 与 光的颜色。
   「读」往左、「写」往右、「判」往上、「管」往下 —— 这不是随便分的：
   用户看久了会形成肌肉记忆，「今天它在偏写还是偏读」一眼就看出来。
   角度用 π 的分数，跟 thS 无关，引擎里再夹到可见范围。 */
const TOOL_GROUP: [RegExp, number, 0 | 1 | 2][] = [
  [/^(web_search|bili_search|search|kb_|rag_|doc_ask|list_|get_)/, -0.62, 0],
  [/^(note_|canvas_|plan_doc_|memory_|course_add|source_import)/, 0.58, 1],
  [/^(grade_|exam_|quiz_|make_|gen_)/, 0.16, 2],
  [/^(pick_|mark_|log_|schedule_|plan_|set_)/, -0.20, 1],
]

export function strokeOfTool(name: string): Stroke {
  const g = TOOL_GROUP.find(([re]) => re.test(name || ''))
  return { angle: g ? g[1] : 0.02, strength: 0.85, tone: g ? g[2] : 0 }
}

/* 一条气泡（一轮任务）当前的状态 → 是否该重拍一次。
   只有 running / ask 值得打光；done 打光会变成「一直在放烟花」。 */
export function isAlive(b: Bubble) { return b.state === 'running' || b.state === 'ask' }

/* 顶栏那五个 KPI。全部来自真实数据，取不到就是 0 —— 不填假数。 */
export type Kpis = {
  mems: number
  links: number
  tools: number
  lessons: { done: number; total: number }
  dueToday: number
  running: number
}

export function kpisOf(snap: Snapshot | null, base: any): Kpis {
  const k = base?.kpi || {}
  return {
    mems: snap?.stats?.total ?? (snap?.mems.length || 0),
    links: snap?.stats?.links ?? (snap?.links.length || 0),
    tools: snap?.calls.length || 0,
    lessons: { done: k.lesson_done || 0, total: k.lesson_total || 0 },
    dueToday: base?.vocab?.mem_counts?.due_today || 0,
    running: (snap?.bubbles || []).filter(isAlive).length,
  }
}

/* 记忆类型的分布（右栏图例 / 顶栏小字用） */
/** 三层的中文名（界面、图例共用一份） */
export const LAYER_CN: Record<string, string> = {
  core: '常驻',
  recall: '近期',
  archival: '归档',
}

export const LAYER_ORDER = ['core', 'recall', 'archival'] as const

export function kindBars(snap: Snapshot | null): { k: MemKind; cn: string; n: number }[] {
  const stat = snap?.stats?.kinds
  if (stat && stat.length) {
    return KINDS_ORDER.map((k) => {
      const hit = stat.find((x) => x.k === k)
      return { k, cn: hit?.cn || KIND_CN_LOCAL[k], n: hit?.n || 0 }
    })
  }
  const m = new Map<string, number>()
  for (const r of snap?.mems || []) m.set(r.kind, (m.get(r.kind) || 0) + 1)
  return KINDS_ORDER.map((k) => ({ k, cn: KIND_CN_LOCAL[k], n: m.get(k) || 0 }))
}

const KIND_CN_LOCAL: Record<MemKind, string> = {
  pref: '偏好', fact: '事实', difficulty: '困难点', goal: '目标', change: '变更',
  insight: '洞察',
}
