import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

/* 模式选择器：标准 / 计划 / 自动。
 *
 * 为什么单独一个控件、不并进权限档：
 *   权限档回答「写盘要不要我点一下」，模式回答「这一轮它该怎么干活」。
 *   两件事混在一起，人会分不清「我到底是没给它权限，还是没让它动手」。
 *
 * 计划模式有个硬承诺：**只读**。后端在 tools.call 里对写盘工具直接拒绝，
 * 所以选了它，界面要让人一眼看出来现在是「只读」状态。
 */

type ModeInfo = { cn: string; desc: string; on: boolean; k: string }

export function ModePicker({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<{ mode: string; info?: any; all: ModeInfo[] } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = () => {
    fetch('/api/mode').then((r) => r.json())
      .then((d) => setSt(d)).catch(() => {})
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function pick(k: string) {
    setOpen(false)
    const r = await fetch('/api/mode', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: k }),
    }).then((x) => x.json()).catch(() => null)
    if (r) setSt(r)
  }

  const cur = st?.info?.cn || '标准'
  const isPlan = (st?.mode || 'standard') === 'plan'

  return (
    <div className="modewrap" ref={wrapRef}>
      <button
        className={'modebtn' + (isPlan ? ' plan' : '') + (open ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={'模式：' + cur + '（' + (st?.info?.desc || '') + '）'}
      >
        <Icon n={isPlan ? 'writing' : 'agent'} size={12} />
        <span>{cur}</span>
        <svg className="eff-cv" width="9" height="9" viewBox="0 0 18 18"
          stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
          <path d={open ? 'M4 11l5-5 5 5' : 'M4 7l5 5 5-5'} />
        </svg>
      </button>

      {open ? (
        <div className="modepop" role="listbox">
          <div className="modepop-h">这一轮怎么干</div>
          {(st?.all || []).map((m) => (
            <button
              key={m.k}
              className={'modeitem' + (m.on ? ' on' : '')}
              onClick={() => pick(m.k)}
              role="option"
              aria-selected={m.on}
            >
              <div className="modeitem-top">
                <b>{m.cn}</b>
                {m.k === 'plan' ? <em className="tagro">只读</em> : null}
                {m.on ? <Icon n="check" size={12} /> : null}
              </div>
              <span>{m.desc}</span>
            </button>
          ))}
          <div className="modepop-f">
            计划模式只是「先出方案」，不会改本机任何东西。
          </div>
        </div>
      ) : null}
    </div>
  )
}
