import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { md } from '../md'

/* 计划文档卡：计划模式产出的方案，摆在对话流里等人点头。
 *
 * 为什么它不是普通消息：
 *   普通消息是「它说的」，计划文档是「它提议要做的」——
 *   人需要能**看全文**、能**批准**、能**丢掉**，三件事都得有明确的按钮。
 *   批准之后它才真的去改本机（那是下一轮的事）。
 */

export type PlanDoc = {
  id: string
  title: string
  status: string          // draft / approved / done / dropped
  path?: string
  created_at?: string
  body?: string
}

const ST: Record<string, { cn: string; color: string }> = {
  draft: { cn: '待你决定', color: '#ffb020' },
  approved: { cn: '已批准', color: '#5ac882' },
  done: { cn: '已完成', color: '#5ac8fa' },
  dropped: { cn: '已丢弃', color: '#8a8a8a' },
}

export function PlanCard({
  doc, onDecide,
}: {
  doc: PlanDoc
  onDecide?: (id: string, status: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState(doc.body || '')
  const [busy, setBusy] = useState(false)
  const st = ST[doc.status] || ST.draft

  /* 正文按需拉：一轮里可能有好几份方案，不该一次性全读进来 */
  useEffect(() => {
    if (!open || body) return
    fetch('/api/plan-doc/' + encodeURIComponent(doc.id))
      .then((r) => r.json())
      .then((d) => { if (d?.ok && d.doc) setBody(d.doc.body || '') })
      .catch(() => {})
  }, [open, body, doc.id])

  async function decide(status: string) {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/plan-doc/' + encodeURIComponent(doc.id) + '/status', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      onDecide?.(doc.id, status)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={'plancard' + (doc.status === 'dropped' ? ' dead' : '')}>
      <div className="plancard-h">
        <span className="plancard-ic"><Icon n="writing" size={13} /></span>
        <b>{doc.title || '计划'}</b>
        <em className="planst" style={{ color: st.color, borderColor: st.color + '55' }}>
          {st.cn}
        </em>
        <button className="plancard-tg" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '看全文'}
        </button>
      </div>

      {open ? (
        <div className="plancard-body">
          {body ? (
            <div className="planmd" dangerouslySetInnerHTML={{ __html: md(body) }} />
          ) : (
            <div className="plancard-wait">正在读这份方案…</div>
          )}
        </div>
      ) : null}

      {doc.status === 'draft' ? (
        <div className="plancard-f">
          <button className="btn sm act" disabled={busy} onClick={() => decide('approved')}>
            {busy ? '处理中…' : '按这个来'}
          </button>
          <button className="btn sm" disabled={busy} onClick={() => decide('dropped')}>
            算了
          </button>
          <span className="plancard-hint">批准之后它才会真的去改计划</span>
        </div>
      ) : null}
    </div>
  )
}
