/* ============================================================
   lib/keys.ts —— 快捷键的唯一事实源

   原来快捷键散在五处各写各的：
     App.tsx       Ctrl+F          全局搜索
     Classroom.tsx S / 空格        截帧 / 播放暂停
     Canvas.tsx    Delete/Ctrl+Z…  10 个键
     Agent.tsx     Esc
   每处都自己拼 keydown、自己判「焦点在不在输入框」。加一个键要改三处，
   改一次默认值要记得同步 —— 迟早不一致。

   这里集中定义「有哪些动作、默认什么键、什么时候不该触发」，
   设置页读写这份表，各处只调 useHotkey(action, fn)。
   ============================================================ */

export type ActionId =
  | 'search'        // 全局搜索
  | 'shot'          // 截当前这一帧（课堂页）/ 截图并提问（其他页）
  | 'playToggle'    // 播放 / 暂停
  | 'shotAsk'       // 截图并直接问 AI

export type KeyDef = {
  id: ActionId
  label: string
  desc: string
  /** 默认绑定，形如 'Ctrl+Shift+S'、'S'、'Space' */
  def: string
  /** 在输入框里打字时是否仍然触发（默认 false：不抢键） */
  inInput?: boolean
}

/* 顺序即设置页显示顺序。 */
export const KEY_DEFS: KeyDef[] = [
  { id: 'search', label: '全局搜索', desc: '任何页面唤起搜索弹窗', def: 'Ctrl+F' },
  { id: 'shot', label: '截这一帧', desc: '课堂页暂停并截帧入库；其他页面截当前画面', def: 'S' },
  { id: 'shotAsk', label: '截图并提问', desc: '截下来直接发给助手，打开置顶小窗', def: 'Ctrl+Shift+S' },
  { id: 'playToggle', label: '播放 / 暂停', desc: '课堂页控制视频', def: 'Space' },
]

const STORE = 'sd.keys.v1'

export type KeyMap = Record<string, string>

export function loadKeys(): KeyMap {
  try {
    const raw = localStorage.getItem(STORE)
    if (raw) {
      const o = JSON.parse(raw)
      if (o && typeof o === 'object') {
        // 缺的用默认值补齐（新加动作时老配置也能用）
        const out: KeyMap = {}
        for (const d of KEY_DEFS) out[d.id] = typeof o[d.id] === 'string' && o[d.id] ? o[d.id] : d.def
        return out
      }
    }
  } catch { /* 隐私模式读不了，用默认值就行 */ }
  const out: KeyMap = {}
  for (const d of KEY_DEFS) out[d.id] = d.def
  return out
}

export function saveKeys(m: KeyMap) {
  try { localStorage.setItem(STORE, JSON.stringify(m)) } catch { /* 写不了不影响本次会话 */ }
}

export function resetKeys(): KeyMap {
  try { localStorage.removeItem(STORE) } catch { /* 同上 */ }
  return loadKeys()
}

/* ---------- 解析与匹配 ---------- */

type Parsed = { ctrl: boolean; shift: boolean; alt: boolean; key: string }

export function parseCombo(s: string): Parsed {
  const parts = String(s || '').split('+').map((x) => x.trim()).filter(Boolean)
  const out: Parsed = { ctrl: false, shift: false, alt: false, key: '' }
  for (const p of parts) {
    const l = p.toLowerCase()
    if (l === 'ctrl' || l === 'cmd' || l === 'meta') out.ctrl = true
    else if (l === 'shift') out.shift = true
    else if (l === 'alt' || l === 'option') out.alt = true
    else out.key = p
  }
  return out
}

/** 事件是否命中这条绑定。Ctrl 和 Cmd 等价（Mac 用 cmd）。 */
export function matches(e: KeyboardEvent, combo: string): boolean {
  const c = parseCombo(combo)
  if (!c.key) return false
  const mod = e.ctrlKey || e.metaKey
  if (c.ctrl !== mod) return false
  if (c.shift !== e.shiftKey) return false
  if (c.alt !== e.altKey) return false
  const k = c.key.toLowerCase()
  const ek = (e.key || '').toLowerCase()
  if (k === 'space') return ek === ' ' || e.code === 'Space'
  return ek === k
}

/** 焦点在输入控件里？这些地方一律不抢键（除非动作声明 inInput）。 */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  const tag = (t.tagName || '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable
}

/** 把事件格式化成可显示的字符串，用于设置页「按下就是它」的录制。 */
export function comboOf(e: KeyboardEvent): string {
  const mod = e.ctrlKey || e.metaKey
  const parts: string[] = []
  if (mod) parts.push('Ctrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  let k = e.key || ''
  if (k === ' ') k = 'Space'
  // 单独的修饰键不成组合
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return ''
  if (k.length === 1) k = k.toUpperCase()
  parts.push(k)
  return parts.join('+')
}
