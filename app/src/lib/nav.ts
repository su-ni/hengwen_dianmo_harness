/* ============================================================================
   lib/nav.ts —— AI 自组织侧边栏的前端数据层

   后端负责「生成 + 双重过滤」，这里只做三件事：类型、取/生成、key→图标映射。
   ★ 图标不由模型产出：模型只给 key / label / why，图标是这张常量表，
     防注入也防模型编出前端不认识的图标名。
   ============================================================================ */

import type { PageKey } from '../components/Shell'
import type { IconName } from '../components/Icon'

export type NavEntry = { key: PageKey; label: string; why?: string }
export type NavConfig = {
  ok: boolean
  items: NavEntry[]
  tabs: NavEntry[]
  source: 'ai' | 'rules' | 'default'
  model?: string
  reason?: string
  at: number
}

/** key → 图标。跟 backend CATALOG 一一对应。 */
export const NAV_ICON: Record<string, IconName> = {
  home: 'courses', today: 'today', classroom: 'classroom', schedule: 'schedule',
  practice: 'practice', vocab: 'vocab', exam: 'exam', stats: 'stats',
  courses: 'courses', shots: 'img', notesAll: 'writing', canvas: 'canvas',
  skills: 'stack', haloflux: 'canvas', agent: 'agent', notes: 'writing',
}

/** 全量兜底：接口挂了也不能让左栏消失。 */
export function defaultNav(): NavConfig {
  const all: NavEntry[] = [
    { key: 'today', label: '今日' }, { key: 'home', label: '课程主页' },
    { key: 'classroom', label: '课堂' }, { key: 'schedule', label: '课表' },
    { key: 'practice', label: '练习' }, { key: 'notesAll', label: '笔记' },
    { key: 'vocab', label: '背单词' }, { key: 'exam', label: '考场' },
    { key: 'stats', label: '统计' }, { key: 'courses', label: '课程库' },
    { key: 'canvas', label: '画布' }, { key: 'shots', label: '截图库' },
    { key: 'skills', label: '技能中心' }, { key: 'haloflux', label: 'haloflux' },
    { key: 'agent', label: '设置' },
  ]
  return { ok: true, items: all, tabs: [], source: 'default', at: 0 }
}

/** 把后端返回的陌生 key 再挡一次（双保险） */
function sanitize(d: any): NavConfig {
  if (!d || !Array.isArray(d.items) || !d.items.length) return defaultNav()
  const items: NavEntry[] = d.items
    .filter((x: any) => x && typeof x.key === 'string' && x.key in NAV_ICON)
    .map((x: any) => ({
      key: x.key as PageKey,
      label: String(x.label || NAV_ICON[x.key] || x.key).slice(0, 12),
      why: String(x.why || '').slice(0, 60),
    }))
  const tabs: NavEntry[] = (Array.isArray(d.tabs) ? d.tabs : [])
    .filter((x: any) => x && typeof x.key === 'string' && x.key in NAV_ICON)
    .map((x: any) => ({
      key: x.key as PageKey,
      label: String(x.label || x.key).slice(0, 12),
      why: String(x.why || '').slice(0, 60),
    }))
  if (!items.length) return defaultNav()
  return {
    ok: true, items, tabs,
    source: (d.source === 'ai' || d.source === 'rules') ? d.source : 'default',
    model: String(d.model || ''),
    reason: String(d.reason || ''),
    at: Number(d.at) || 0,
  }
}

export async function fetchNav(): Promise<NavConfig> {
  try {
    const r = await fetch('/api/nav/current').then(x => x.json())
    return sanitize(r)
  } catch {
    return defaultNav()
  }
}

/** 写一句需求 → 重新生成。失败返回 null，调用方保持上一版，不白屏。 */
export async function generateNav(text: string): Promise<NavConfig | null> {
  try {
    const r = await fetch('/api/nav/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text }),
    }).then(x => x.json())
    return sanitize(r)
  } catch {
    return null
  }
}

/** 事件：对话里发完一句就广播，让 Shell 重新拉配置 */
export const NAV_REFRESH = 'sd:nav-refresh'
export function askNavRefresh(): void {
  window.dispatchEvent(new Event(NAV_REFRESH))
}

/* ----------------------------------------------------------------------------
   只改需求时才重生成
   ----------------------------------------------------------------------------
   为什么需要：上一版每发一句都调一次 WorkBuddy，闲聊、追问、
   「按这个方案开始做」也白烧一次模型（2~3 秒 + 一次调用）。

   判定 = 排除非需求 → 命中需求信号 → 跟上次不同。三层都过才生成。
   纯前端快筛，不额外调模型（否则省调用的意义就没了）。
   ---------------------------------------------------------------------------- */

const LAST_KEY = 'sd.nav.lastText'

export function readLastNavText(): string {
  try { return sessionStorage.getItem(LAST_KEY) || '' } catch { return '' }
}
export function saveLastNavText(t: string): void {
  try { sessionStorage.setItem(LAST_KEY, t) } catch { /* 隐私模式：记不住就每次判 */ }
}

/** 明显不是需求：追问、确认、闲聊、批准后的固定执行句。
    这些句子里也可能带「课」字，所以优先排除，不走需求信号。 */
const NON_INTENT = /^(好的|好|嗯|哦|行|可以|继续|然后呢|然后|为什么|为啥|怎么|怎么样|什么|是吗|对|不对|再来|还有|谢谢|谢了|哈喽|你好|hi|ok|嗯呢|那呢|接着说|说下去)[\s?？。！,，]*$/i
const APPROVE_BOILERPLATE = /^按这个方案开始做|^直接执行|^接着干|^继续上一步/

/** 需求信号：说清了「要做什么 / 换成什么 / 重点在哪」。 */
const INTENT = /备考|准备|我要|想要|需要|帮我|给我|改成|换成|改为|接下来|重点|主攻|专攻|目标|计划|安排|排个|排一下|刷|背|复习|转向|不.*了|别.*了|专[注攻]|主要|先学|先搞|换成|以.*为主|考|学到/

export function shouldRegenerate(text: string, lastText: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  // 批准方案后 Chat 自动发的那句是执行指令，不是新需求
  if (APPROVE_BOILERPLATE.test(t)) return false
  // 追问 / 闲聊 / 确认短句
  if (NON_INTENT.test(t) || t.length < 3) return false
  // 得说清了要干嘛
  if (!INTENT.test(t)) return false
  // 跟上次生成用的文本一样（或只差标点空白）→ 不重复烧模型
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '')
  if (lastText && norm(t) === norm(lastText)) return false
  return true
}

/** 挂调试口：验证「只改需求才重生成」的判定，不改状态 */
export function exposeNavDebug(): void {
  ;(window as any).__navShould = (t: string) => shouldRegenerate(t, readLastNavText())
  ;(window as any).__navLast = readLastNavText
}
