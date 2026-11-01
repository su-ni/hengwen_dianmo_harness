import { useEffect, useMemo, useRef, useState } from 'react'

/* 统一命令面板 —— 输入框上方弹出的那一张。
 *
 * 为什么合并成一个：加号（添加文件）、@（引用）、斜杠（指令）本质都是
 * 「从一张清单里挑一项」，分成三套弹窗只会三套样式、三处 bug。
 * 现在一张面板，靠分组区分：
 *
 *   添加
 *     文件      file        任意格式，可多选
 *     文件夹    dir         整个目录收进来
 *     截图库    shots       课堂截帧 / 画布导出
 *   指令
 *     压缩      compress    压缩以上对话内容
 *     模型      model       选择本次会话使用的模型
 *     导出      export      将当前会话导出为文件
 *     计划      plan        按考试日期拆到每天
 *
 * 交互（对齐 Codex / DSH）：
 *   · 输入框里打 `@` 或 `/`，或点 `+` 按钮 → 面板出现在**输入框上方**
 *   · 打字即过滤（匹配中文名 / 英文 key / 说明文字）
 *   · ↑↓ 移动、Enter 选中、Esc 关闭；鼠标悬停同步高亮
 */

export type CmdItem = {
  k: string          // 唯一键
  cn: string         // 中文名
  en?: string        // 英文 key（灰字，跟参考实现一致）
  hint?: string      // 右侧说明
  group: string      // 分组：添加 / 指令
  icon?: string      // Icon 名
  run: () => void    // 选中后干什么
}

export function CommandPalette({
  open, query, items, active, setActive, onPick, onClose, anchor, above, mode,
}: {
  open: boolean
  query: string
  items: CmdItem[]
  /* '+' = 全出；'/' = 只出指令；'@' = 只出「添加/引用」那组 */
  mode?: '' | '+' | '/' | '@'
  active: number
  setActive: (i: number) => void
  onPick: (it: CmdItem) => void
  onClose: () => void
  /* 定位：left 是相对父容器的左偏移；bottom 是**距父容器底边的距离**。
     面板要贴在输入框上方，父容器是输入框整体（.dm-box / .cbox），
     所以传 bottom = 框高 + 8 由调用方算，或者用 putAbove 让组件自己贴顶。 */
  anchor: { left: number; bottom: number | string }
  /* true = 贴着父容器的上沿往外长（不用算高度） */
  above?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  const list = useMemo(() => {
    /* 先按触发方式收范围：/ 只给指令，@ 只给「添加」那组（引用/文件），
       点 + 不限制。再按关键词过滤。 */
    let pool = items
    if (mode === '/') pool = items.filter((x) => x.group === '指令')
    else if (mode === '@') pool = items.filter((x) => x.group === '添加')
    const q = query.trim().toLowerCase()
    if (!q) return pool
    return pool.filter((x) =>
      (x.cn + ' ' + (x.en || '') + ' ' + (x.hint || '') + ' ' + x.k).toLowerCase().includes(q))
  }, [items, query, mode])

  /* 分组渲染：保持 items 的原始顺序，按 group 切块 */
  const groups = useMemo(() => {
    const out: { name: string; rows: CmdItem[] }[] = []
    list.forEach((it) => {
      const last = out[out.length - 1]
      if (last && last.name === it.group) last.rows.push(it)
      else out.push({ name: it.group, rows: [it] })
    })
    return out
  }, [list])

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

  if (!open) return null

  let idx = -1
  return (
    <div
      ref={ref}
      className="cp-pop"
      style={above
        ? { left: anchor.left, bottom: '100%', marginBottom: 8 }
        : { left: anchor.left, bottom: anchor.bottom }}
      role="listbox"
      aria-label="命令"
    >
      {groups.length ? groups.map((g) => (
        <div className="cp-g" key={g.name}>
          <div className="cp-gh">{g.name}</div>
          {g.rows.map((it) => {
            idx += 1
            const i = idx
            return (
              <button
                key={it.k}
                className={'cp-i' + (i === active ? ' on' : '')}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(it)}
                role="option"
                aria-selected={i === active}
              >
                {it.icon ? <i className="cp-ic"><CmdIcon n={it.icon} /></i> : null}
                <span className="cp-cn">{it.cn}</span>
                {it.en ? <span className="cp-en">{it.en}</span> : null}
                <span className="cp-hint">{it.hint || ''}</span>
              </button>
            )
          })}
        </div>
      )) : (
        <div className="cp-empty">没搜到</div>
      )}
    </div>
  )
}

/* 面板图标：16px 线性 SVG。
 * 之前用 CSS 画方块占位（border + 圆角），看着像「没做完的占位符」——
 * 每一项长得都差不多，分不出是文件还是指令。这里画真图形：
 * 文件=折角纸、文件夹=带舌片的夹、截图=相框+太阳、压缩=上下箭头收拢、
 * 模型=芯片、导出=下箭头+托盘、计划=日历格。
 */
function CmdIcon({ n }: { n: string }) {
  const c = { width: 16, height: 16, viewBox: '0 0 18 18', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  switch (n) {
    case 'file':
      return <svg {...c}><path d="M4.5 2.5h5l4 4v9h-9z" /><path d="M9.5 2.5v4h4" /></svg>
    case 'dir':
      return <svg {...c}><path d="M2.5 5.2A1.4 1.4 0 0 1 3.9 3.8h3l1.3 1.6h5.9a1.4 1.4 0 0 1 1.4 1.4v7a1.4 1.4 0 0 1-1.4 1.4H3.9a1.4 1.4 0 0 1-1.4-1.4z" /></svg>
    case 'shots':
      return <svg {...c}><rect x="2.5" y="4" width="13" height="10" rx="1.6" /><circle cx="6.5" cy="7.2" r="1.3" /><path d="M2.8 12.2l3.4-3 2.8 2.4 2.2-1.9 3.9 3.1" /></svg>
    case 'compress':
      return <svg {...c}><path d="M9 2.5v5M9 15.5v-5" /><path d="M6.4 5.1L9 7.7l2.6-2.6M6.4 12.9L9 10.3l2.6 2.6" /><path d="M3 9h2.4M12.6 9H15" opacity=".55" /></svg>
    case 'model':
      return <svg {...c}><rect x="5.5" y="5.5" width="7" height="7" rx="1.6" /><path d="M8 2.5v3M10 2.5v3M8 12.5v3M10 12.5v3M2.5 8h3M2.5 10h3M12.5 8h3M12.5 10h3" /></svg>
    case 'export':
      return <svg {...c}><path d="M9 2.5v8" /><path d="M6 7.6L9 10.6l3-3" /><path d="M2.8 12.4v2.2a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1v-2.2" /></svg>
    case 'plan':
      return <svg {...c}><rect x="2.5" y="4" width="13" height="11.5" rx="1.6" /><path d="M2.5 7.4h13M6.4 2.5v3M11.6 2.5v3" /><rect x="5.4" y="9.6" width="2.6" height="2.4" rx=".6" opacity=".75" /></svg>
    default:
      return <svg {...c}><circle cx="9" cy="9" r="5.5" /></svg>
  }
}

/** 从输入框的值与光标位置判断触发符：'@' | '/' | null */
export function detectCmd(v: string, caret: number): { trigger: '@' | '/'; query: string; start: number } | null {
  if (caret <= 0) return null
  for (let i = caret - 1; i >= 0 && caret - i <= 24; i--) {
    const ch = v[i]
    if (ch === '@' || ch === '/') {
      const prev = i > 0 ? v[i - 1] : ' '
      if (prev !== ' ' && prev !== '\n' && prev !== '\t' && i !== 0) continue
      return { trigger: ch as '@' | '/', query: v.slice(i + 1, caret), start: i }
    }
    if (ch === ' ' || ch === '\n' || ch === '\t') return null
  }
  return null
}
