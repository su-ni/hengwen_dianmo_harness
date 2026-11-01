import { useEffect, useRef } from 'react'

/* 通用右键菜单 —— 工作区与会话共用一套。
 *
 * 为什么自己写而不是复用 usePopover：那个 hook 是按「锚点元素」定位的，
 * 右键菜单要按**鼠标坐标**定位，两者约束不一样（菜单可能贴着屏幕边缘，
 * 需要反向展开）。这里只做坐标 + 视口夹边，比塞进 usePopover 更清楚。
 *
 * 关闭时机（对齐画布页那套已跑通的经验）：
 *   Esc / 点外部 / 滚动 / 窗口尺寸变化 —— 任何一条都关，别留一个飘着的菜单。
 */

export type MenuItem =
  | { type?: 'item'; label: string; hint?: string; danger?: boolean; onClick: () => void; disabled?: boolean }
  | { type: 'sep' }
  | { type: 'group'; label: string }

export function ContextMenu({
  x, y, items, onClose, width = 208,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  /* 视口夹边：贴右边缘就往左展开、贴底就往上展开。
     用菜单实际高度算，而不是估一个固定值。 */
  const h = ref.current?.offsetHeight || items.length * 34 + 16
  const left = Math.max(6, Math.min(x, window.innerWidth - width - 6))
  const top = Math.max(6, Math.min(y, window.innerHeight - h - 6))

  return (
    <div
      ref={ref}
      className="ctxmenu"
      style={{ left, top, width }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => {
        if (it.type === 'sep') return <div className="ctx-sep" key={'s' + i} />
        if (it.type === 'group') {
          return <div className="ctx-g" key={'g' + i}>{it.label}</div>
        }
        return (
          <button
            key={it.label + i}
            className={'ctx-i' + (it.danger ? ' danger' : '')}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick() }}
          >
            <span>{it.label}</span>
            {it.hint ? <em>{it.hint}</em> : null}
          </button>
        )
      })}
    </div>
  )
}

/* 二次确认弹窗 —— 删除这类不可逆操作专用。 */
export function ConfirmBox({
  title, body, confirmText, danger, children, onOk, onCancel,
}: {
  title: string
  body?: string
  confirmText: string
  danger?: boolean
  children?: React.ReactNode
  onOk: () => void
  onCancel: () => void
}) {
  return (
    <div className="dm-mask" onClick={onCancel}>
      <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
        <b className="cb-t">{title}</b>
        {body ? <p className="cb-b">{body}</p> : null}
        {children}
        <div className="cb-f">
          <button className="btn sm" onClick={onCancel}>算了</button>
          <button className={'btn sm ' + (danger ? 'dgr' : 'act')} onClick={onOk}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
