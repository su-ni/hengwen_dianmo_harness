/* ============================================================
   ShotDock —— 截图置顶小窗

   需求（用户原话）：
     「截图之后会生成一个置顶的小窗，用来与 AI 对话。小窗会一直存在，
       除非用户手动关闭。」
     「截图可以直接截取视频中的题目用来解答，不需要用户手动发送，
       解答结果也会呈现在对话里面，这与对话是不冲突的。」

   复用而非重写：
     · 发送：callTool('agent_turn')，与 Chat.send 同一套接口
     · 附件：与 Chat 一致，把真实路径拼成「[附件] path」交给模型
     · 样式：复用 .hfx-* 之外的既有卡片语法（边框 + 极简），不另造设计语言
     · 状态：不自己轮询，靠 App 传来的 last 结果驱动

   与主对话「不冲突」的做法：小窗有自己的 session（session_new / 独立 sid），
   不抢占当前会话指针 —— 关掉它，主对话还在原处。
   ============================================================ */
import { useCallback, useEffect, useRef, useState } from 'react'
import { callTool } from '../lib/api'
import { Icon } from './Icon'

export type DockShot = { path?: string; title?: string; pos_sec?: number | null; lesson?: string }

type Turn = { role: 'user' | 'ai'; text: string; busy?: boolean }

export function ShotDock({ shot, onClose }: { shot: DockShot | null; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [min, setMin] = useState(false)
  /* 小窗用独立会话：与主对话隔离，关掉它不影响主对话在哪。
     会话 id 懒创建 —— 用户没发话之前不占一条空会话。 */
  const sidRef = useRef<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  /* 新截图进来：自动发一轮（用户要求的「不需要手动发送」）。 */
  useEffect(() => {
    if (!shot?.path) return
    setMsgs([{ role: 'user', text: '看看这张' + (shot.pos_sec != null ? '（' + fmt(shot.pos_sec) + '）' : '') }])
    setErr('')
    void send('这张图里如果是一道题，请把题干、选项和正确答案一起给我；如果不是题，就说你看到了什么。', shot.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot?.path])

  /* 新消息滚到底 —— 小窗高度固定，不滚看不到新内容。 */
  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])

  const send = useCallback(async (q: string, path?: string) => {
    const attach = path || shot?.path
    if (!q.trim() && !attach) return
    setBusy(true)
    setErr('')
    setMsgs((m) => [...m, { role: 'ai', text: '', busy: true }])
    try {
      /* 与 Chat 完全一致的拼法：人话 + [附件] 真实路径。
         模型侧靠 fs_read 读图，不在这里另造一套附件协议。 */
      /* 图片走 images 参数**直接给模型看**，不再只拼一行「[附件] path」。
         路径同时还留在正文里：万一这一家模型不吃图，模型至少知道有这么一个文件。 */
      const forModel = q || '看看这张图'
      const r = await callTool<any>('agent_turn', {
        text: attach ? forModel + '\n\n[附件] ' + attach : forModel,
        images: attach ? [attach] : undefined,
        focus: 'dock',
      }, { write: true })
      const ans = r.ok ? String(r.data?.text || r.data?.say || '（没回话）') : ('出错了：' + (r.error || '未知'))
      if (!r.ok) setErr(r.error || '出错了')
      setMsgs((m) => {
        const n = m.slice()
        const last = n[n.length - 1]
        if (last && last.role === 'ai') n[n.length - 1] = { role: 'ai', text: ans }
        return n
      })
    } catch (e) {
      const msg = String(e).slice(0, 120)
      setErr(msg)
      setMsgs((m) => {
        const n = m.slice()
        const last = n[n.length - 1]
        if (last && last.role === 'ai') n[n.length - 1] = { role: 'ai', text: '连不上本机服务：' + msg }
        return n
      })
    } finally {
      setBusy(false)
    }
  }, [shot?.path])

  if (!shot) return null

  return (
    <aside className={'sdock' + (min ? ' min' : '')} role="dialog" aria-label="截图提问">
      <header className="sdock-hd">
        <b>截图提问</b>
        {shot.pos_sec != null ? <span className="t">{fmt(shot.pos_sec)}</span> : null}
        <div className="sdock-act">
          <button className="sdock-i" onClick={() => setMin((v) => !v)} title={min ? '展开' : '收起'}>
            <Icon n="chev" size={13} />
          </button>
          <button className="sdock-i" onClick={onClose} title="关掉"><Icon n="x" size={14} /></button>
        </div>
      </header>

      {min ? null : (
        <>
          {!shot.path ? (
            <div className="sdock-note">没拿到图：在课堂页按一次会直接截当前这一帧；在别的页面需要授权屏幕录制。</div>
          ) : null}
          {shot.path ? (
            <div className="sdock-pic">
              <img src={'/shots/' + String(shot.path).replace(/^shotted\//, '')} alt="截图" />
              <span>{shot.title || '截图'}</span>
            </div>
          ) : null}

          <div className="sdock-body" ref={boxRef}>
            {msgs.map((m, i) => (
              <div key={i} className={'sdock-m ' + m.role}>
                {m.busy ? <span className="muted">正在看…</span> : m.text}
              </div>
            ))}
            {err ? <div className="sdock-err">{err}</div> : null}
          </div>

          <div className="sdock-ft">
            <input
              className="inp-mn"
              placeholder="接着问它（Enter 发送）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) { const q = text; setText(''); void send(q) }
                e.stopPropagation()
              }}
            />
            <button className="pbtn-mn" disabled={busy || (!text.trim() && !shot.path)}
              onClick={() => { const q = text; setText(''); void send(q) }}>
              {busy ? '…' : '发送'}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}

/* 秒 → 12:34，与课堂页同一口径（不另写一个格式化）。 */
function fmt(sec: number) {
  const t = Math.max(0, Math.round(sec))
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0')
}
