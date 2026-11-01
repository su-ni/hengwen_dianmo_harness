import { useEffect, useMemo, useRef, useState } from 'react'

/* @ 引用 / / 指令 —— 输入框里的就地触发面板。
 *
 * 交互（对齐 Codex / DSH 那类编辑器）：
 *   · 在输入框里打 `@` → 弹出可搜列表：工作区文件、课程讲次、笔记、截图
 *   · 在输入框里打 `/` → 弹出指令列表：压缩上下文、切模型、清屏、导出…
 *   · ↑↓ 选择、Enter 确认、Esc 关闭；选中后把对应片段插进正文并**高亮标记**
 *
 * 为什么自己算光标位置：没有富文本编辑器，靠 textarea 的 selectionStart
 * 判断「刚打的是不是触发符」，再把触发符前面的词当过滤词。
 */

export type Mention = { kind: string; id: string; label: string; hint?: string }

type Item = { k: string; label: string; hint?: string; kind?: string }

const SLASH: Item[] = [
  { k: '/压缩', label: '压缩上下文', hint: 'compress —— 把长对话折成摘要', kind: 'cmd' },
  { k: '/模型', label: '切换模型', hint: 'model —— 换提供商 / 推理等级', kind: 'cmd' },
  { k: '/计划', label: '排学习计划', hint: 'plan —— 让它按考试日期拆到每天', kind: 'cmd' },
  { k: '/复习', label: '今天复习什么', hint: 'review —— 按到期与错因排队', kind: 'cmd' },
  { k: '/导出', label: '导出这段对话', hint: 'export', kind: 'cmd' },
  { k: '/清空', label: '清空这条会话', hint: 'clear', kind: 'cmd' },
]

export function SlashMention({
  open, trigger, query, anchor, items, onPick, onClose, active, setActive,
}: {
  open: boolean
  trigger: '@' | '/' | ''
  query: string
  /* 面板相对输入框定位用 */
  anchor: { left: number; bottom: number } | null
  items: Item[]
  onPick: (it: Item) => void
  onClose: () => void
  active: number
  setActive: (i: number) => void
}) {
  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((x) =>
      (x.label + ' ' + (x.hint || '') + ' ' + x.k).toLowerCase().includes(q))
  }, [items, query])

  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(list.length - 1, active + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)) }
      else if (e.key === 'Enter' && list[active]) { e.preventDefault(); onPick(list[active]) }
      else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, list, active, onPick, onClose, setActive])

  if (!open || !anchor || !list.length) return null

  return (
    <div
      ref={ref}
      className="sm-pop"
      style={{ left: anchor.left, bottom: anchor.bottom }}
      role="listbox"
      aria-label={trigger === '@' ? '引用' : '指令'}
    >
      <div className="sm-h">
        <b>{trigger === '@' ? '引用' : '指令'}</b>
        <em>{query || '（继续输入可筛选）'}</em>
      </div>
      <div className="sm-list">
        {list.map((it, i) => (
          <button
            key={it.k}
            className={'sm-i' + (i === active ? ' on' : '')}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(it)}
            role="option"
            aria-selected={i === active}
          >
            <span className="sm-k">{it.label}</span>
            {it.hint ? <span className="sm-d">{it.hint}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 从 textarea 的值与光标位置判断是否该弹面板，返回触发符、过滤词、起点索引。 */
export function detectTrigger(v: string, caret: number): {
  trigger: '@' | '/'; query: string; start: number
} | null {
  if (caret <= 0) return null
  // 往前找最近的触发符；遇到空白就停
  for (let i = caret - 1; i >= 0 && caret - i <= 24; i--) {
    const ch = v[i]
    if (ch === '@' || ch === '/') {
      // 触发符前面必须是行首或空白，避免把邮箱里的 @ 当成引用
      const prev = i > 0 ? v[i - 1] : ' '
      if (prev !== ' ' && prev !== '\n' && prev !== '\t' && i !== 0) continue
      return { trigger: ch as '@' | '/', query: v.slice(i + 1, caret), start: i }
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return null
  }
  return null
}
