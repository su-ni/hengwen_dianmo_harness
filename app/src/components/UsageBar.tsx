import { useState } from 'react'
import { Icon } from './Icon'

/* 用量状态条 —— 会话页与首屏共用同一个组件。
 *
 * 为什么要单独抽出来（用户 2026-10-31 指出）：
 *   首屏自己写了一个简化版对话区，状态条（N 轮 M 步 · tok/s · 缓存命中 %）
 *   压根没做；而会话页里那条现成的就在 ChatStat 里。
 *   两边各写一份的结果就是「一个有一个没有」。抽到这里之后，
 *   谁要显示用量就 <UsageBar meta={...} busy={...} />，长得完全一样。
 *
 * 数据全部来自 end 帧的 meta：没有的项整行不画，不写 0、不拿别的单位顶上。
 */

export type Usage = {
  provider?: string; model?: string; ms?: number; tok_s?: number
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number
  cache_read_input_tokens?: number; reasoning_tokens?: number
  ctx?: number; ctx_pct?: number
  cum_tokens?: number; cum_prompt?: number; cum_cache_read?: number
}

export type StatMeta = {
  usage?: Usage
  rounds?: number
  max_rounds?: number
  ctx?: { total?: number; kept?: number; folded?: number; tight?: boolean }
}

function fmtTok(n?: number) {
  if (typeof n !== 'number' || !isFinite(n)) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

export function UsageBar({
  meta, busy, steps, hint,
}: {
  meta?: StatMeta
  busy?: boolean
  /* 这一轮实际走了几步（trace 长度）；不传就只显示轮次 */
  steps?: number
  /* 没有用量时显示的提示语（默认给按键提示） */
  hint?: string
}) {
  const [open, setOpen] = useState(false)
  const u = meta?.usage
  const rounds = meta?.rounds || 0
  const nSteps = steps || 0
  const cumTok = u?.cum_tokens
  const cachePct = (u?.cum_prompt && u?.cum_cache_read)
    ? Math.round((u.cum_cache_read * 100) / u.cum_prompt) : null
  const pct = u?.ctx_pct
  const hasAny = rounds > 0 || !!u

  if (!hasAny) {
    return (
      <span className="cstat-tip">
        {hint || 'Enter 发送 · Shift+Enter 换行'}
      </span>
    )
  }

  const r = 5.4, C = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct || 0))
  const ringColor = p >= 80 ? 'var(--bad)' : p >= 50 ? 'var(--warn)' : 'var(--act)'

  const rows: [string, string][] = []
  if (meta?.usage?.provider) {
    rows.push(['模型', (u!.provider || '') + (u!.model ? ' · ' + u!.model : '')])
  }
  if (rounds > 0) {
    rows.push(['轮次', `${rounds}${meta?.max_rounds ? '/' + meta.max_rounds : ''} 轮 · ${nSteps} 步`])
  }
  if (typeof u?.ms === 'number') rows.push(['本轮耗时', (u.ms / 1000).toFixed(1) + ' 秒'])
  if (typeof u?.tok_s === 'number') rows.push(['吐字速度', u.tok_s + ' tok/s'])
  if (typeof u?.prompt_tokens === 'number') rows.push(['本轮输入', fmtTok(u.prompt_tokens) + ' tok'])
  if (typeof u?.completion_tokens === 'number') rows.push(['本轮输出', fmtTok(u.completion_tokens) + ' tok'])
  if (typeof u?.total_tokens === 'number') rows.push(['本轮合计', fmtTok(u.total_tokens) + ' tok'])
  if (typeof u?.cache_read_input_tokens === 'number') {
    rows.push(['命中缓存', fmtTok(u.cache_read_input_tokens) + ' tok'])
  }
  if (typeof u?.reasoning_tokens === 'number') {
    rows.push(['思考用量', fmtTok(u.reasoning_tokens) + ' tok'])
  }
  if (typeof cumTok === 'number' && cumTok > 0) {
    rows.push(['累计 token', fmtTok(cumTok) + (cachePct != null ? `（缓存命中 ${cachePct}%）` : '')])
  }
  if (typeof u?.ctx === 'number') rows.push(['上下文窗口', fmtTok(u.ctx) + ' tok'])
  if (typeof pct === 'number') rows.push(['本次占用', p + '%'])

  return (
    <div className="cstat-wrap">
      {open ? (
        <div className="cstat-pop" role="dialog" aria-label="这一轮的用量明细">
          <div className="csp-hd">
            <b>这一轮的账</b>
            <button className="csp-x" onClick={() => setOpen(false)} aria-label="收起">×</button>
          </div>
          <div className="csp-body">
            {rows.map(([k, v]) => (
              <div className="csp-row" key={k}>
                <span className="csp-k">{k}</span>
                <span className="csp-v">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <button className="cstat" onClick={() => setOpen((o) => !o)} title="点开看这一轮的用量明细">
        {rounds > 0 ? (
          <span className="cst">
            <Icon n="clock" size={12} />
            {rounds} 轮 {nSteps} 步{u?.tok_s ? ` · ${u.tok_s} tok/s` : ''}
          </span>
        ) : null}
        {typeof cumTok === 'number' && cumTok > 0 ? (
          <span className="cst">
            <Icon n="stack" size={12} />
            {fmtTok(cumTok)} tok{cachePct != null ? ` · 缓存命中 ${cachePct}%` : ''}
          </span>
        ) : null}
        {typeof pct === 'number' ? (
          <span className="cst">
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden>
              <circle cx="7" cy="7" r={r} fill="none" stroke="var(--line2)" strokeWidth="1.7" />
              <circle cx="7" cy="7" r={r} fill="none" stroke={ringColor} strokeWidth="1.7"
                strokeDasharray={`${(C * p) / 100} ${C}`} strokeLinecap="round"
                transform="rotate(-90 7 7)" />
            </svg>
            {p}%
          </span>
        ) : null}
        {busy ? <span className="cst run">跑着…</span> : null}
        <span className="cst-more">{open ? '收起' : '详情'}</span>
      </button>
    </div>
  )
}
