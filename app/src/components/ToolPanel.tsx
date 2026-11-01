import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'

/* 右侧可视化面板 —— AI 调工具时滑出，对话区左移。
 *
 * 用户的意见：不能只是「打印文字」，要有真正的可视化。
 * 所以每一类工具都有自己的图形语言：
 *
 *   搜索   → 命中数 + 结果卡片流（编号 / 标题 / 来源域名 / 摘要）
 *   排课   → 横向时长条（长度按时长，颜色按科目）
 *   写盘   → 文件路径拆成「目录 + 文件名」+ 变更条
 *   出题   → 题号网格 + 题干预览
 *   媒体   → 缩略图网格位
 *   其它   → 键值摘要表（不打印原始 JSON）
 *
 * 左侧是一条竖着串起来的轨迹（点、名字、状态色），不是普通列表。
 */

export type ToolCall = {
  tool: string
  args?: Record<string, unknown>
  ms?: number
  ok?: boolean
  summary?: any
  error?: string
  need_confirm?: boolean
  ui?: any
  running?: boolean
}

type Kind = 'search' | 'plan' | 'file' | 'quiz' | 'media' | 'other'

function kindOf(tool: string): Kind {
  const t = (tool || '').toLowerCase()
  if (/search|bili_|web_|fetch|kb_|find/.test(t)) return 'search'
  if (/plan|schedule|budget|week|today|pick_next/.test(t)) return 'plan'
  if (/fs_|file|note_save|note_del|db_exec|course_add|source_import|shot_save/.test(t)) return 'file'
  if (/quiz|question|exam|grade|practice|submit|paper_make/.test(t)) return 'quiz'
  if (/shot|canvas|stream|video|play|frame/.test(t)) return 'media'
  return 'other'
}

const KIND_META: Record<Kind, { cn: string; color: string }> = {
  search: { cn: '搜索', color: '#5ac8fa' },
  plan: { cn: '排课', color: '#ffb020' },
  file: { cn: '写盘', color: '#a06bff' },
  quiz: { cn: '出题', color: '#5ac882' },
  media: { cn: '媒体', color: '#ff7a9c' },
  other: { cn: '其它', color: '#8a8a8a' },
}

function parsed(v: any): any {
  if (v == null) return null
  if (typeof v === 'object') return v
  const s = String(v).trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return null
  try { return JSON.parse(s) } catch { return null }
}

function pickRows(v: any): any[] {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'object') {
    for (const k of ['rows', 'results', 'items', 'words', 'hits', 'list',
      'questions', 'papers', 'sources', 'lessons', 'shots', 'days', 'data',
      'items', 'videos', 'vlist', 'courses']) {
      if (Array.isArray(v[k])) return v[k]
    }
  }
  return []
}

export function ToolPanel({
  calls, busy, open, onClose,
}: {
  calls: ToolCall[]
  busy: boolean
  open: boolean
  onClose: () => void
}) {
  const [sel, setSel] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const live = calls.filter((c) => c.running)

  useEffect(() => {
    if (!calls.length) return
    const finished = calls.map((c, i) => ({ c, i })).filter((x) => !x.c.running)
    if (finished.length) setSel(finished[finished.length - 1].i)
  }, [calls.length])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [sel])

  const counts = useMemo(() => {
    const m = {} as Record<Kind, number>
    calls.forEach((c) => { const k = kindOf(c.tool); m[k] = (m[k] || 0) + 1 })
    return m
  }, [calls])

  const cur = calls[sel]
  if (!open) return null

  return (
    <aside className="tpanel">
      <div className="tp-head">
        <div className="tp-title">
          <span className={'tp-dot' + (busy || live.length ? ' live' : '')} />
          <b>工具轨迹</b>
          <span className="tp-n">{calls.length}</span>
        </div>
        <button className="tp-x" onClick={onClose} title="收起">
          <Icon n="x" size={12} />
        </button>
      </div>

      {calls.length ? (
        <div className="tp-kinds">
          {(Object.keys(KIND_META) as Kind[]).filter((k) => counts[k]).map((k) => (
            <span key={k} className="tp-k" style={{ ['--kc' as any]: KIND_META[k].color }}>
              <i />{KIND_META[k].cn}<b>{counts[k]}</b>
            </span>
          ))}
          {live.length ? <span className="tp-live">正在跑 {live.length}</span> : null}
        </div>
      ) : null}

      {calls.length ? (
        <div className="tp-split">
          <div className="tp-rail">
            {calls.map((c, i) => {
              const k = kindOf(c.tool)
              return (
                <button
                  key={i}
                  className={'tp-node' + (i === sel ? ' on' : '')
                    + (c.ok === false ? ' bad' : '') + (c.running ? ' run' : '')}
                  onClick={() => setSel(i)}
                  title={c.tool}
                  style={{ ['--kc' as any]: KIND_META[k].color }}
                >
                  <span className="tp-node-dot" />
                  <span className="tp-node-name">{shortName(c.tool)}</span>
                </button>
              )
            })}
          </div>

          <div className="tp-body" ref={bodyRef}>
            {cur ? <Detail c={cur} /> : null}
          </div>
        </div>
      ) : (
        <div className="tp-idle">
          <div className="tp-idle-anim"><span /><span /><span /></div>
          <p>AI 调工具的时候，这里会显示它查到了什么</p>
          <div className="tp-idle-kinds">
            {(Object.keys(KIND_META) as Kind[]).map((k) => (
              <span key={k} style={{ ['--kc' as any]: KIND_META[k].color }}>
                <i />{KIND_META[k].cn}
              </span>
            ))}
          </div>
        </div>
      )}
    </aside>
  )
}

function shortName(t: string) {
  return (t || '').replace(/^t_/, '').replace(/_/g, ' ')
}

/* ================= 详情 ================= */

function Detail({ c }: { c: ToolCall }) {
  const k = kindOf(c.tool)
  const meta = KIND_META[k]
  const p = parsed(c.summary)
  const rows = pickRows(c.ui).length ? pickRows(c.ui) : pickRows(p)

  return (
    <div className="tp-detail" style={{ ['--kc' as any]: meta.color }}>
      <div className="tp-dh">
        <span className="tp-dh-kind" style={{ background: meta.color }}>{meta.cn}</span>
        <code>{c.tool}</code>
        {c.running ? <span className="tp-badge run">跑着</span>
          : c.ok === false ? <span className="tp-badge bad">失败</span>
            : <span className="tp-badge ok">{fmtMs(c.ms)}</span>}
      </div>

      {c.error ? <div className="tp-err">{c.error}</div> : null}

      {c.args && Object.keys(c.args).length ? (
        <div className="tp-kv">
          {Object.entries(c.args).slice(0, 5).map(([key, val]) => (
            <div key={key}><span>{key}</span><em>{fmtVal(val)}</em></div>
          ))}
        </div>
      ) : null}

      {k === 'plan' ? <PlanViz rows={rows} c={c} /> : null}
      {k === 'search' ? <SearchViz rows={rows} c={c} /> : null}
      {k === 'file' ? <FileViz c={c} rows={rows} /> : null}
      {k === 'quiz' ? <QuizViz rows={rows} c={c} /> : null}
      {k === 'media' ? <MediaViz rows={rows} c={c} /> : null}
      {k === 'other' ? <OtherViz c={c} rows={rows} /> : null}

      {!rows.length && !c.args && !c.error && !c.running ? (
        <div className="tp-none">这个工具没留结果摘要</div>
      ) : null}
    </div>
  )
}

/* ============================================================
 * 可视化 = 展示「过程怎么走的」，不是把结果数据罗列出来。
 * 每类工具拆成几步，步与步之间串起来，让人看得见
 * 「它先干嘛、再干嘛、最后定了什么」。
 * ============================================================ */

function Step({ n, t, d, extra }: { n: string; t: string; d?: string; extra?: React.ReactNode }) {
  return (
    <div className="vz-step">
      <span className="vz-step-n">{n}</span>
      <div className="vz-step-b">
        <b>{t}</b>
        {d ? <span>{d}</span> : null}
        {extra}
      </div>
    </div>
  )
}

/* ---------- 搜索：过程步骤 + 指向对话流里的卡片 ----------
 * B 站搜到的课，对话流里已经有**带封面、UP 主、播放量、「用这门」按钮**的
 * 完整卡片网格（Chat 原有的 ui:courses 渲染），比右栏能做的更好。
 * 所以右栏只讲过程：搜了什么词、回来几条、挑了哪几条 ——
 * 具体每条课去对话流里看、去点。不在这里重复渲染一遍差版。
 */
function SearchViz({ rows, c }: { rows: any[]; c: ToolCall }) {
  const p = parsed(c.summary) || {}
  const kw = String(c.args?.keyword ?? c.args?.q ?? p.keyword ?? '')
  const n = num(p.n ?? rows.length)
  const first = rows[0] || {}
  return (
    <div className="vz">
      <Step n="1" t="拿着关键词去 B 站搜" d={kw || '（关键词见对话）'} />
      <Step n="2" t={`搜回来 ${n || rows.length} 条候选`} d="封面、播放量、时长都核过了" />
      <Step n="3" t="把值得入课的挑出来" d="对话流里那排卡片就是搜到的结果，点「用这门」直接入库" />
      <div className="vz-peek">
        {rows.slice(0, 4).map((it, i) => (
          <div className="vz-peek-r" key={i}>
            <span>{i + 1}</span>
            <b>{String(it.title || '').slice(0, 34)}</b>
            <em>{it.up ? String(it.up).slice(0, 10) : ''}</em>
          </div>
        ))}
        {rows.length > 4 ? <div className="vz-more">还有 {rows.length - 4} 条在对话流里</div> : null}
      </div>
      <div className="vz-note">细看和入库 → 去左边对话流的那排课卡</div>
    </div>
  )
}

/* ---------- 排课：算预算 → 分七天 → 每天几点学什么 ---------- */
function PlanViz({ rows, c }: { rows: any[]; c: ToolCall }) {
  const p = parsed(c.summary) || {}
  const days = (c.ui && c.ui.days) || p.days || (Array.isArray(rows) ? rows : [])
  if (!days.length) return <OtherViz c={c} rows={rows} />
  const perDay = num(p.minutes_per_day || (c.ui && c.ui.minutes_per_day))
  const total = days.reduce((a: number, d: any) => a + num(d.minutes), 0)
  return (
    <div className="vz">
      <Step n="1" t="先看还剩多少时间"
        d={[p.exam_date ? '考试 ' + p.exam_date : '', p.days_left ? '还有 ' + p.days_left + ' 天' : '']
          .filter(Boolean).join(' · ') || '按每天配额排'} />
      {perDay ? <Step n="2" t={'每天能学 ' + perDay + ' 分钟'} d={'七天合计 ' + Math.round(total) + ' 分钟'} /> : null}
      <Step n="3" t="把课拆到每一天" d="每块颜色 = 一门课，长度 = 学多久" />
      <div className="vz-days">
        {days.slice(0, 7).map((d: any, i: number) => (
          <div className={'vz-day' + (d.is_today ? ' today' : '')} key={i}>
            <div className="vz-day-h">
              <b>{d.wd != null ? WD[d.wd] : ''}</b>
              <span>{String(d.date || '').slice(5)}</span>
              <em>{num(d.minutes) + '′'}</em>
            </div>
            <div className="vz-day-bar">
              {(d.blocks || []).map((b: any, j: number) => (
                <i key={j} style={{ flex: num(b.minutes) || 1, background: subjColor(b.subject || b.cls) }}
                  title={b.title} />
              ))}
            </div>
            {(d.blocks || []).slice(0, 3).map((b: any, j: number) => (
              <div className="vz-day-l" key={j}>
                <i style={{ background: subjColor(b.subject || b.cls) }} />
                <span>{(b.start ? b.start + ' ' : '') + String(b.title || '').slice(0, 18)}</span>
                <em>{num(b.minutes) + '′'}</em>
              </div>
            ))}
            {(d.blocks || []).length > 3 ? (
              <div className="vz-day-more">还有 {((d.blocks || []).length - 3)} 块</div>
            ) : null}
          </div>
        ))}
      </div>
      {p.rule ? <div className="vz-rule">排法：{String(p.rule).slice(0, 90)}</div> : null}
    </div>
  )
}

function FileViz({ c, rows }: { c: ToolCall; rows: any[] }) {
  const p = parsed(c.summary) || {}
  const path = String(c.args?.path || c.args?.file || c.args?.wid || c.args?.id || '')
  const n = num(c.args?.bytes) || num(p.bytes) || rows.length

  /* 入库类（course_add / source_import / vocab_pull）没有路径，
     但有一句「入了 3 门 / 失败 1 门」的结果。
     给它一张结果条，别把 JSON 摊给人看 —— 那是调试视图，不是给人看的。 */
  const say = String(p.say || p.note || '')
  const added = num(p.added ?? p.n)
  const failed = num(p.failed)
  if (!path && (say || added > 0)) {
    return (
      <div className="viz-file">
        <div className="viz-import">
          <div className="viz-import-h">
            <span className="viz-import-ic"><Icon n="check" size={11} /></span>
            <b>{added > 0 ? '入库了 ' + added + ' 项' : '写完了'}</b>
            {failed > 0 ? <em className="viz-import-bad">{failed} 项没过</em> : null}
          </div>
          {say ? <p>{say.slice(0, 160)}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="viz-file">
      {path ? (
        <div className="viz-f-path">
          <span className="viz-f-dir">{path.replace(/[^/\\]*$/, '')}</span>
          <b>{path.split(/[/\\]/).pop()}</b>
        </div>
      ) : null}
      {n ? <div className="viz-f-bar"><i /></div> : null}
      {say ? <p className="viz-file-say">{say.slice(0, 160)}</p> : null}
    </div>
  )
}


function QuizViz({ rows, c }: { rows: any[]; c: ToolCall }) {
  if (!rows.length) return <OtherViz c={c} rows={rows} />
  return (
    <div className="viz-quiz">
      <div className="viz-q-grid">
        {rows.slice(0, 30).map((_, i) => <i key={i}>{i + 1}</i>)}
      </div>
      {rows.slice(0, 5).map((r, i) => (
        <div className="viz-q-card" key={i}>
          <span>{i + 1}</span>
          <p>{String(r.stem || r.q || r.title || '').slice(0, 90)}</p>
        </div>
      ))}
    </div>
  )
}

function MediaViz({ rows, c }: { rows: any[]; c: ToolCall }) {
  if (!rows.length) return <OtherViz c={c} rows={rows} />
  return (
    <div className="viz-media">
      {rows.slice(0, 9).map((r, i) => (
        <div className="viz-m-cell" key={i} title={r.title || r.file || ''}>
          <i className="viz-m-ic" />
        </div>
      ))}
    </div>
  )
}

function OtherViz({ c, rows }: { c: ToolCall; rows: any[] }) {
  const flat = flatten(parsed(c.summary))
  if (rows.length) {
    return (
      <div className="viz-list">
        {rows.slice(0, 10).map((r, i) => (
          <div key={i}>
            <span>{i + 1}</span>
            <b>{String(r.title || r.name || r.w || r.q || r.id || '—').slice(0, 50)}</b>
          </div>
        ))}
        {rows.length > 10 ? <em className="viz-more">还有 {rows.length - 10} 条</em> : null}
      </div>
    )
  }
  if (flat.length) {
    return (
      <div className="tp-kv">
        {flat.slice(0, 8).map(([k, v]) => (
          <div key={k}><span>{k}</span><em>{String(v).slice(0, 40)}</em></div>
        ))}
      </div>
    )
  }
  if (c.summary) return <pre className="viz-raw">{pretty(c.summary)}</pre>
  return null
}

/* ---------- 小工具 ---------- */
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function fmtPlay(n: any): string {
  const v = num(n)
  if (!v) return ''
  return v >= 10000 ? (v / 10000).toFixed(1) + ' 万播放' : v + ' 播放'
}
function fmtDur(sec: any): string {
  const v = num(sec)
  if (!v) return ''
  const h = Math.floor(v / 3600)
  const m = Math.round((v % 3600) / 60)
  return h ? h + ' 小时 ' + m + ' 分' : m + ' 分'
}
function num(v: any): number { const n = Number(v); return isFinite(n) ? n : 0 }
function fmtVal(v: any): string {
  if (v == null) return '—'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40)
  return String(v).slice(0, 44)
}
function fmtMs(ms?: number): string {
  if (!ms) return '完成'
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
}
function safeHost(u: string) {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u.slice(0, 24) }
}
function pretty(v: any) {
  if (v == null) return ''
  if (typeof v === 'string') return v.slice(0, 1200)
  try { return JSON.stringify(v, null, 2).slice(0, 1200) } catch { return String(v) }
}
function flatten(o: any, pre = ''): [string, any][] {
  if (!o || typeof o !== 'object') return []
  const out: [string, any][] = []
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue
    if (typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, pre + k + '.'))
    else if (!Array.isArray(v)) out.push([pre + k, v])
    else out.push([pre + k, `${v.length} 条`])
  }
  return out
}
function subjColor(s?: string) {
  const t = String(s || '').toLowerCase()
  if (/math|高数|数学|bl|blue/.test(t)) return '#5ac8fa'
  if (/english|英语|en\b/.test(t)) return '#ff7a9c'
  if (/clang|c语言|cs|计算机/.test(t)) return '#ffb020'
  if (/politics|政治|vo\b/.test(t)) return '#a06bff'
  return '#5ac882'
}
