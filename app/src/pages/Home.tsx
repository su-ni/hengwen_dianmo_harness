import { useEffect, useMemo, useRef, useState } from 'react'
import { callTool, type Base } from '../lib/api'
import { Icon } from '../components/Icon'
import { Sel } from '../components/Sel'

/* ================= 全局首屏：工作区列表 + 一个能聊的框 =================

   这一页回答一个问题：「我现在在哪个学习任务里？」
   - 还没建工作区：只有中间那个框，说一句「我要考专升本，明年三月考」就开一条。
   - 已经建了：左边/中间是工作区卡片，点一个就进它（进去之后才是原来那整站：
     课程主页 / 课堂 / 练习 / 考场 / 画布 …）。

   **新会话 ≠ 新建工作区**（用户 2026-10-31 定的）：这个框默认就是聊天，
   只有人明确说「新建一个工作区 / 再学一门别的」时才建。所以这里给两条路：
   ① 框里直接说话 —— 交给 Agent，它自己判断要不要建；
   ② 卡片区右上角「新建工作区」按钮 —— 人明确要建时才走这条。
*/

type WS = {
  id: string
  name: string
  kind: string
  icon?: string | null
  exam_date?: string | null
  minutes_per_day?: number | null
  vocab_minutes?: number | null
  modules?: string[]
  subjects?: { subject_id: string; lessons_per_day: number }[]
  archived?: number
  created_at?: string
}

const KIND_CN: Record<string, string> = {
  study: '学习', exam: '应试', hobby: '兴趣',
}

function daysTo(d?: string | null): number | null {
  if (!d) return null
  const t = Date.parse(String(d).replace(/[-/]/g, '/'))
  if (!isFinite(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

export function Home({
  base, onOpen, onGo,
}: {
  base: Base | null
  /* 进某个工作区（App 里切 page=home 并设当前工作区） */
  onOpen: (wid: string) => void
  onGo?: (p: any) => void
}) {
  const [list, setList] = useState<WS[]>(() => ((base as any)?.workspaces as WS[]) || [])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [mk, setMk] = useState(false)          // 新建面板
  const [mkName, setMkName] = useState('')
  const [mkDate, setMkDate] = useState('')
  const [mkMin, setMkMin] = useState('150')
  const [sess, setSess] = useState<any[]>([])
  const [reply, setReply] = useState<string>('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  /* 列表以 base 为准（切页回来能同步），但本页自己也能改（新建/删除后不必等轮询） */
  useEffect(() => {
    const b = ((base as any)?.workspaces as WS[]) || []
    setList(b)
  }, [base])

  useEffect(() => {
    callTool<any>('session_list', { limit: 12 }).then((r) => {
      if (r.ok) setSess((r.data as any)?.items || (r.data as any)?.sessions || [])
    }).catch(() => { /* 会话列表拿不到不影响首屏：它只是「最近聊过」 */ })
  }, [])

  const curId = ((base as any)?.ws as WS | null)?.id || ''
  const empty = list.length === 0

  async function createWs(o?: { name?: string; exam_date?: string; minutes_per_day?: string }) {
    const name = (o?.name ?? mkName).trim() || '未命名工作区'
    setBusy(true)
    setErr('')
    const r = await callTool<any>('ws_create' in {} ? 'ws_create' : 'ws_new', {
      name,
      exam_date: (o?.exam_date ?? mkDate) || undefined,
      minutes_per_day: Number((o?.minutes_per_day ?? mkMin) || 0) || undefined,
    }, { write: true }).catch((e) => ({ ok: false, error: String(e) }))
    setBusy(false)
    // 后端可能还没注册 ws_* 工具（一期先走 HTTP）
    const w = (r as any)?.ok ? (r as any).data?.ws : null
    if (!w) {
      const resp = await fetch('/api/ws', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, exam_date: (o?.exam_date ?? mkDate) || null,
          minutes_per_day: Number((o?.minutes_per_day ?? mkMin) || 0) || null }),
      }).then((x) => x.json()).catch(() => null)
      if (!resp?.ok) { setErr(resp?.error || '新建工作区失败'); return }
      setList((l) => [resp.ws, ...l])
      setMk(false); setMkName(''); setMkDate('')
      onOpen(resp.ws.id)
      return
    }
    setList((l) => [w, ...l])
    setMk(false); setMkName(''); setMkDate('')
    onOpen(w.id)
  }

  async function send() {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true); setErr(''); setReply('')
    setText('')
    try {
      // 首屏这个框先走非流式：一句话换一句话，够用；真正的长跑在会话页里。
      const r = await callTool<any>('agent_say', { text: q }, { write: true })
      if (!r.ok) setErr(r.error || '没连上模型')
      else {
        const d: any = r.data || {}
        setReply(String(d.say || d.text || d.reply || '').slice(0, 900) || '（模型没说正文）')
        // 模型可能顺手建了工作区：刷新一次列表
        const ws = await fetch('/api/ws').then((x) => x.json()).catch(() => null)
        if (ws?.ok) setList(ws.items || [])
      }
    } finally {
      setBusy(false)
    }
  }

  const cards = useMemo(() => list.filter((w) => !w.archived), [list])

  return (
    <div className={'ghome' + (empty ? ' is-empty' : '')}>
      <div className="gh-head">
        <div className="gh-logo"><span className="gh-mark">研</span><b>研学台</b><em>StudyDeck</em></div>
        <div className="sp" />
        <button className="btn sm" onClick={() => setMk(true)}>
          <Icon n="plus" size={12} /> 新建工作区
        </button>
      </div>

      <div className="gh-body">
        {!empty ? (
          <section className="gh-ws">
            <div className="gh-sec">
              <b>工作区</b>
              <span className="gh-note">每个工作区装一个学习任务 —— 科目、计划、进度、会话各归各的</span>
            </div>
            <div className="gh-cards">
              {cards.map((w) => {
                const dd = daysTo(w.exam_date)
                return (
                  <button key={w.id} className={'wscard' + (w.id === curId ? ' on' : '')}
                    onClick={() => onOpen(w.id)}>
                    <div className="wsc-top">
                      <span className="wsc-k">{KIND_CN[w.kind] || w.kind}</span>
                      {dd != null ? <span className={'wsc-d' + (dd < 30 ? ' near' : '')}>距考 {dd} 天</span> : null}
                    </div>
                    <b className="wsc-n">{w.name}</b>
                    <div className="wsc-m">
                      {(w.subjects || []).length
                        ? (w.subjects || []).map((s) => s.subject_id).join(' · ')
                        : '还没有挂科目'}
                    </div>
                    <div className="wsc-f">
                      <span>{w.minutes_per_day ? w.minutes_per_day + ' 分钟/天' : '未设时长'}</span>
                      <span>{(w.modules || []).length} 个模块</span>
                    </div>
                  </button>
                )
              })}
              {/* 空位卡：工作区少的时候右半边空着，人会以为「就这样了」。
                  摆一张虚线卡，把「还能再开一个」明说出来 —— 点它就是新建。 */}
              <button className="wscard add" onClick={() => setMk(true)}>
                <div className="wsc-add">
                  <Icon n="plus" size={16} />
                  <b>再开一个工作区</b>
                  <em>另一个目标、另一门考试、或者纯兴趣</em>
                </div>
              </button>
            </div>
            {sess.length ? (
              <div className="gh-recent">
                <div className="gh-sec"><b>最近聊过</b></div>
                {sess.slice(0, 5).map((s: any) => (
                  <button key={s.id} className="gh-srow" onClick={() => onGo && onGo('today')}>
                    <Icon n="today" size={12} />
                    <span>{s.title || '（没起名）'}</span>
                    <em>{s.updated_at || ''}</em>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : (
          <div className="gh-hero">
            <h1>想学什么，直接说</h1>
            <p>告诉我目标、什么时候考、每天能学多久 —— 我会把这些拆成一个能执行的工作区。</p>
          </div>
        )}

        {reply ? (
          <div className="gh-reply">
            <span className="who">助手</span>
            <pre>{reply}</pre>
          </div>
        ) : null}
        {err ? <div className="gh-err">{err}</div> : null}
      </div>

      <div className="gh-dock">
        <div className="gh-box">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={empty
              ? '说一句：我要专升本，明年三月考，每天能学两小时'
              : '说句话。问进度、排计划、或者新建一个工作区都行'}
            onChange={(e) => {
              setText(e.target.value)
              const t = e.currentTarget
              t.style.height = 'auto'
              t.style.height = Math.min(t.scrollHeight, 140) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }}
          />
          <div className="gh-bar">
            <button className="ion" title="加附件（拖进来也行）" onClick={() => {
              const inp = document.createElement('input')
              inp.type = 'file'; inp.multiple = true
              inp.onchange = () => {
                const fs = inp.files
                if (fs && fs.length) {
                  const names = Array.from(fs).map((f) => f.name).join('、')
                  setText((t) => t + (t ? '\n' : '') + `[附件] ${names}`)
                }
              }
              inp.click()
            }}><Icon n="plus" size={13} /></button>
            <button className="ion" title="引用工作区里的文件 / 课程 / 笔记" onClick={() => setText((t) => t + (t.endsWith('@') ? '' : ' @'))}>
              <b style={{ fontSize: 12 }}>@</b>
            </button>
            <div className="sp" />
            <button className="send" onClick={send} disabled={busy || !text.trim()}
              title={busy ? '正在想…' : '发出去（Enter）'}>
              <Icon n="chev" size={13} />
            </button>
          </div>
        </div>
        <div className="gh-tip">Enter 发送 · Shift+Enter 换行 · 新建工作区请点右上角，别在这里说</div>
      </div>

      {mk ? (
        <div className="gh-mask" onClick={() => setMk(false)}>
          <div className="gh-modal" onClick={(e) => e.stopPropagation()}>
            <b className="gh-mt">新建工作区</b>
            <label className="gh-f">
              <span>叫什么</span>
              <input value={mkName} placeholder="例如：2027 专升本 · 摄影入门"
                onChange={(e) => setMkName(e.target.value)} autoFocus />
            </label>
            <label className="gh-f">
              <span>考试日期（可空）</span>
              <input value={mkDate} placeholder="2027-03-15"
                onChange={(e) => setMkDate(e.target.value)} />
            </label>
            <label className="gh-f">
              <span>每天多久（分钟）</span>
              <input value={mkMin} onChange={(e) => setMkMin(e.target.value)} />
            </label>
            <div className="gh-mf">
              <button className="btn sm" onClick={() => setMk(false)}>算了</button>
              <button className="btn sm act" onClick={() => createWs()} disabled={busy}>
                {busy ? '建中…' : '建'}
              </button>
            </div>
            <div className="gh-mn">建完就进去；科目和计划可以在里面慢慢补，也可以让助手问出来。</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
