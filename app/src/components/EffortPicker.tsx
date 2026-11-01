import { useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { usePopover } from '../lib/usePopover'

/* 推理档位（reasoning effort）。
 *
 * 形态对齐 DeepSeek Harness：一个触发按钮 + 一个带滑杆的浮层。
 * 档位名就是模型自己的能力刻度：Off / Minimal / Low / Medium / High / XHigh / Max，
 * 不另造「简要/标准/详细」—— 那会让人以为在调回答长度，实际调的是推理预算。
 *
 * 浮层定位走 usePopover：输入框在最底部，面板天然向上长，但必须夹在视口内，
 * 否则会像之前那样顶出屏幕（用户截图里权限面板漏了一半）。
 */

type Lv = { k: string; why: string; on: boolean }

const LABEL: Record<string, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium',
  high: 'High', xhigh: 'XHigh', max: 'Max',
}

export function EffortPicker({ disabled }: { disabled?: boolean }) {
  const [cur, setCur] = useState('medium')
  const [levels, setLevels] = useState<Lv[]>([])
  const [open, setOpen] = useState(false)
  const { anchorRef, popRef, pos } = usePopover(open, () => setOpen(false))
  const rangeRef = useRef<HTMLInputElement>(null)

  async function load() {
    const r = await callTool<{ current: string; levels: Lv[] }>('agent_effort', {})
    if (r.ok && r.data) {
      setCur(r.data.current || 'medium')
      setLevels(r.data.levels || [])
    }
  }

  useEffect(() => { load() }, [])

  async function pick(k: string) {
    if (k === cur || disabled) return
    setCur(k)
    const r = await callTool<{ ok: boolean; current: string }>(
      'agent_effort', { level: k }, { write: true })
    if (r.ok && r.data) setCur(r.data.current)
  }

  const keys = levels.length ? levels.map((x) => x.k) : ['low', 'medium', 'high']
  const idx = Math.max(0, keys.indexOf(cur))
  const pct = keys.length > 1 ? (idx / (keys.length - 1)) * 100 : 100
  const why = levels.find((x) => x.k === cur)?.why || ''

  return (
    <div className="eff">
      <button
        ref={(el) => { anchorRef.current = el }}
        className={'eff-trig' + (open ? ' on' : '')}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={'推理档位：' + (LABEL[cur] || cur) + (why ? ' · ' + why : '')}
      >
        <span className="eff-dot" aria-hidden="true" />
        <span className="eff-cur">{LABEL[cur] || cur}</span>
        <svg className="eff-cv" width="10" height="10" viewBox="0 0 18 18"
          stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round">
          <path d="M4 7l5 5 5-5" />
        </svg>
      </button>

      {open && pos ? (
        <div
          ref={popRef}
          className={'eff-pop' + (pos.up ? ' up' : ' down')}
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH }}
          role="dialog"
          aria-label="推理等级"
        >
          <div className="eff-pop-h">
            <b>推理等级</b>
            <span className="eff-pop-v">{LABEL[cur] || cur}</span>
          </div>

          <div className="eff-track">
            <div className="eff-fill" style={{ width: pct + '%' }} />
            <input
              ref={rangeRef}
              type="range"
              min={0}
              max={Math.max(0, keys.length - 1)}
              step={1}
              value={idx}
              disabled={disabled}
              onChange={(e) => pick(keys[Number(e.target.value)] || cur)}
              aria-label="推理等级"
            />
          </div>

          <div className="eff-ticks" style={{ gridTemplateColumns: `repeat(${keys.length}, minmax(0,1fr))` }}>
            {keys.map((k, i) => (
              <button
                key={k}
                className={'eff-tick' + (i === idx ? ' on' : '')}
                onClick={() => pick(k)}
                title={levels.find((x) => x.k === k)?.why || LABEL[k] || k}
              >
                {LABEL[k] || k}
              </button>
            ))}
          </div>

          {why ? <div className="eff-why">{why}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
