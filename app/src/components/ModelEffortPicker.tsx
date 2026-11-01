import { useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { usePopover } from '../lib/usePopover'
import { EffortSlider } from './EffortSlider'

/* 模型 + 推理等级：一个控件、两级菜单。
 *
 * 结构（对齐 DeepSeek Harness）：
 *   点触发按钮 → 面板
 *     ①「模型  hy3  ›」→ 右侧飞出**按提供商分组**的模型列表
 *     ②「推理等级  High」→ 拉条
 *
 * 模型列表这一版修了四件事（用户逐条指出）：
 *   1. 显示**提供商**（WorkBuddy / Trae / 自备 Key…），不再一锅平铺
 *   2. 显示**账号**与凭据到期时间；点组头 = 切到这家（换账号）
 *   3. 滚轮只滚列表，不带着整页一起滑（弹层锁 stopPropagation + 边界 preventDefault）
 *   4. 旋钮层级低于能量层：能量条盖在旋钮上（用户要求「被覆盖就不显示」）
 */

type Lv = { k: string; why: string; label: string; on: boolean }
type M = { id: string; name?: string; ctx?: number }
type Prov = {
  provider: string; name: string; configured: boolean; usable: boolean
  why?: string; account?: string; expires_text?: string; login?: string
  model?: string; selected?: boolean; from?: string
}
type EffortPay = { current: string; model: string; provider: string; levels: Lv[]; matched: boolean }
type Group = { p: Prov; models: M[] | null; err?: string }

const clip = (s: string, n = 26) => {
  const t = String(s || '')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function ModelEffortPicker({ disabled }: { disabled?: boolean }) {
  const [ef, setEf] = useState<EffortPay | null>(null)
  const [open, setOpen] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [mq, setMq] = useState('')
  const [busy, setBusy] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const { anchorRef, popRef, pos } = usePopover(open, () => { setOpen(false); setShowModels(false) })

  async function loadEffort() {
    const r = await callTool<EffortPay>('agent_effort', {})
    if (r.ok && r.data) setEf(r.data)
  }

  async function loadAll() {
    if (groups) return
    setBusy('models')
    const r = await callTool<any>('ai_providers')
    const d: any = r.data || {}
    const ps: Prov[] = (d.providers || []).filter((x: Prov) => x.configured || x.usable)
    setGroups(ps.map((p) => ({ p, models: null })))
    ps.forEach((p) => {
      callTool<any>('ai_models', { provider: p.provider }).then((rr) => {
        const dd: any = rr.data || {}
        setGroups((gs) => (gs || []).map((g) => g.p.provider !== p.provider ? g
          : {
            ...g, models: dd.models || [],
            err: (dd.models && dd.models.length) ? '' : (dd.error || dd.note || '这家列不出模型'),
          }))
      })
    })
    setBusy('')
  }

  useEffect(() => { loadEffort() }, [])
  useEffect(() => { if (open) loadAll() }, [open, groups])

  async function pickEffort(k: string) {
    if (disabled || !ef || k === ef.current) return
    const r = await callTool<any>('agent_effort', { level: k }, { write: true })
    if (r.ok && r.data?.current) {
      setEf((prev) => prev ? {
        ...prev, current: r.data.current, levels: r.data.levels || prev.levels,
      } : prev)
    }
  }

  /* 切提供商（= 换账号）：选这家 + 它记着的模型 */
  async function pickProvider(p: Prov) {
    setBusy('switch')
    await callTool<any>('ai_use', { provider: p.provider, model: p.model || undefined }, { write: true })
    setBusy('')
    await loadEffort()
    window.dispatchEvent(new CustomEvent('sd:model'))
  }

  async function pickModel(p: Prov, m: M) {
    setBusy('switch')
    await callTool<any>('ai_use', { provider: p.provider, model: m.id }, { write: true })
    setBusy('')
    await loadEffort()
    window.dispatchEvent(new CustomEvent('sd:model'))
    setShowModels(false); setOpen(false)
  }

  const curModel = ef?.model || ''
  const levels = ef?.levels || []
  const curLv = levels.find((x) => x.k === ef?.current)
  const curLabel = curLv?.label || ef?.current || '—'

  const q = mq.trim().toLowerCase()
  const filtered: Group[] = (groups || []).map((g) => ({
    ...g,
    models: (g.models || []).filter((m) => !q
      || ((m.name || '') + ' ' + (m.id || '')).toLowerCase().includes(q)),
  })).filter((g) => !q || (g.models && g.models.length)
    || (g.p.name || '').toLowerCase().includes(q))

  /* 滚轮只滚列表。
     关键：用**原生** wheel 监听（带 { passive: false }）挂在列表元素上。
     React 的 onWheel 是合成事件，stopPropagation 只作用于 React 树，
     挡不住挂在 window 上的原生监听；而 usePopover 早期版本正是在 window 上
     监听滚动 —— 两下一凑，面板内部的滚动会被当成页面滚动去重算位置，
     表现就是「一滚整块面板往上走」。
     usePopover 那边已经改成忽略弹层内部滚动；这里再加一道原生拦截，
     到边界时 preventDefault，避免滚动链传到页面。 */
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const atTop = el.scrollTop <= 0 && e.deltaY < 0
      const atBot = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && e.deltaY > 0
      if (atTop || atBot) e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [showModels])

  return (
    <div className="eff">
      <button
        ref={(el) => { anchorRef.current = el }}
        className={'eff-trig me-trig' + (open ? ' on' : '')}
        onClick={() => { setOpen((v) => !v); setShowModels(false) }}
        disabled={disabled}
        title={'模型与推理等级：' + (curModel || '未选') + ' · ' + curLabel}
      >
        <span className="me-dot" aria-hidden="true" />
        <span className="me-model">{clip(curModel) || '未选模型'}</span>
        <span className="me-sep" aria-hidden="true">·</span>
        <span className="me-lv">{curLabel}</span>
        <svg className="eff-cv" width="10" height="10" viewBox="0 0 18 18"
          stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round">
          <path d="M4 7l5 5 5-5" />
        </svg>
      </button>

      {open && pos ? (
        <div
          ref={popRef}
          className={'eff-pop me-pop' + (pos.up ? ' up' : ' down') + (pos.flipRight ? ' right' : '')}
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH }}
          role="dialog" aria-label="模型与推理等级"
        >
          <button
            className={'me-row' + (showModels ? ' on' : '')}
            onClick={() => setShowModels((v) => !v)}
          >
            <span className="me-k">模型</span>
            <span className="me-val">{clip(curModel, 20) || '未选'}</span>
            <svg className="me-go" width="11" height="11" viewBox="0 0 18 18"
              stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round">
              <path d="M7 4l5 5-5 5" />
            </svg>
          </button>

          <div className="me-lvbox">
            <div className="me-lvhead">
              <span className="me-k2">推理等级</span>
              <span className="me-v">{curLabel}</span>
            </div>
            <EffortSlider
              levels={levels.map((x) => ({ k: x.k, label: x.label, why: x.why }))}
              value={ef?.current || ''}
              disabled={disabled || !levels.length}
              onChange={pickEffort}
            />
            {curLv?.why ? <div className="me-why">{curLv.why}</div> : null}
          </div>

          {showModels ? (
            <div className="me-sub me-sub-model">
              <div className="me-sub-h">
                <input
                  className="me-q" value={mq} autoFocus placeholder="搜索模型或提供商…"
                  onChange={(e) => setMq(e.target.value)}
                />
              </div>
              <div className="me-sub-list" ref={listRef}>
                {busy === 'models' && !groups ? <div className="me-empty">正在列模型…</div> : null}
                {filtered.map((g) => {
                  const isCur = g.p.provider === ef?.provider || g.p.selected
                  return (
                    <div className="me-group" key={g.p.provider}>
                      <button
                        className={'me-gh' + (isCur ? ' on' : '')}
                        onClick={() => pickProvider(g.p)}
                        disabled={busy === 'switch'}
                        title={g.p.why || '切到这家'}
                      >
                        <span className="me-gh-n">{g.p.name || g.p.provider}</span>
                        <span className="me-gh-a">{g.p.account || (g.p.usable ? '已登录' : '未登录')}</span>
                        {isCur ? <span className="me-gh-ck">✓</span> : null}
                      </button>
                      {g.p.expires_text
                        ? <div className="me-gh-e">凭据到期 {g.p.expires_text}</div> : null}
                      {g.err ? <div className="me-empty sm">{g.err}</div> : null}
                      {(g.models || []).map((m) => (
                        <button
                          key={g.p.provider + '/' + m.id}
                          className={'me-mi' + (m.id === curModel && isCur ? ' on' : '')}
                          onClick={() => pickModel(g.p, m)}
                          disabled={busy === 'switch'}
                          title={m.id + (m.ctx ? ' · ' + Math.round(m.ctx / 1000) + 'k 窗口' : '')}
                        >
                          <span className="me-mi-n">{m.name || m.id}</span>
                          {m.id === curModel && isCur ? <span className="me-mi-ck">✓</span> : null}
                        </button>
                      ))}
                    </div>
                  )
                })}
                {!busy && !filtered.length
                  ? <div className="me-empty">{mq ? '没搜到' : '没有可用的提供商'}</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
