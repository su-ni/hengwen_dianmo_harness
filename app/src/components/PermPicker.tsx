import { useEffect, useState } from 'react'
import { usePopover } from '../lib/usePopover'

/* 权限档：写盘这件事要不要人点一下。
 *
 * 这是人按的开关，不是模型能调的 —— 没有对应工具，只走 /api/perm。
 * 三档对应市面 agent 软件的通用做法：
 *   只看不改  写操作全挡
 *   先问我    写操作弹确认卡（默认）
 *   完全信任  直接落盘，事后在轨迹里留痕
 *
 * 浮层同样走 usePopover：底部输入框往上弹，必须夹在视口内 ——
 * 之前那版用绝对定位，面板会顶出屏幕（用户截图里漏了一半）。
 */

type M = { id: string; why: string }

const SHORT: Record<string, string> = {
  readonly: '只看不改',
  ask: '先问我',
  auto: '完全信任',
}

const HINT: Record<string, string> = {
  readonly: '任何写操作都挡住',
  ask: '改本机的东西先问你一声（默认）',
  auto: '直接落盘，事后告诉你改了什么',
}

export function PermPicker({ disabled }: { disabled?: boolean }) {
  const [mode, setMode] = useState('ask')
  const [modes, setModes] = useState<M[]>([])
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState('')
  const { anchorRef, popRef, pos } = usePopover(open, () => setOpen(false))

  async function load() {
    try {
      const r = await fetch('/api/perm').then((x) => x.json())
      if (r && r.ok) { setMode(r.mode); setModes(r.modes || []) }
    } catch { /* 服务没起就不画 */ }
  }

  useEffect(() => { load() }, [])

  async function pick(k: string) {
    if (disabled) return
    setErr('')
    try {
      const r = await fetch('/api/perm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: k }),
      }).then((x) => x.json())
      if (r.ok) { setMode(r.mode); setOpen(false) } else setErr(r.error || '没换成')
    } catch (e) { setErr(String(e)) }
  }

  const why = modes.find((x) => x.id === mode)?.why || HINT[mode] || ''
  const list: M[] = modes.length
    ? modes
    : (['readonly', 'ask', 'auto'] as const).map((id) => ({ id, why: HINT[id] }))

  return (
    <div className="eff">
      <button
        ref={(el) => { anchorRef.current = el }}
        className={'eff-trig perm-trig'
          + (mode === 'auto' ? ' warn' : mode === 'readonly' ? ' dim' : '')
          + (open ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={'它能改本机吗：' + (why || SHORT[mode])}
      >
        <span className={'perm-dot' + (mode === 'auto' ? ' warn' : mode === 'readonly' ? ' dim' : '')} />
        <span className="eff-cur">{SHORT[mode] || mode}</span>
        <svg className="eff-cv" width="10" height="10" viewBox="0 0 18 18"
          stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round">
          <path d="M4 7l5 5 5-5" />
        </svg>
      </button>

      {open && pos ? (
        <div
          ref={popRef}
          className={'eff-pop perm-pop' + (pos.up ? ' up' : ' down')}
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH }}
          role="dialog"
          aria-label="它能改本机吗"
        >
          <div className="eff-pop-h">
            <b>它能改本机吗</b>
            <span className="eff-pop-v">{SHORT[mode]}</span>
          </div>

          <div className="perm-list">
            {list.map((m) => (
              <button
                key={m.id}
                className={'perm-o' + (m.id === mode ? ' on' : '')
                  + (m.id === 'auto' ? ' warn' : '')}
                onClick={() => pick(m.id)}
              >
                <span className="perm-o-h">
                  <i>{SHORT[m.id] || m.id}</i>
                  {m.id === mode ? <b className="perm-o-on">当前</b> : null}
                </span>
                <em>{m.why || HINT[m.id] || ''}</em>
              </button>
            ))}
          </div>

          {err ? <div className="perm-err">{err}</div> : null}
          <div className="perm-foot">这个开关只有你能按，助手自己改不了。</div>
        </div>
      ) : null}
    </div>
  )
}
