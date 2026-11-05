import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { AskBox, type Ask } from './AskBox'

/* 气泡通知（第 7 章 D18–D22）
 *
 * 形态（D19/D20）：
 *   平时 = 一个 6px 圆点 + 一行 11px 的字。**不长边框、不占面积**，
 *   像贴在页面角上的一行小字，而不是一块浮动面板。
 *   只有「需要你答」时才展开 —— 而且展开的是**同一个提问卡**（AskBox），
 *   不是另造一个单行输入框。模型问多选就出多选，问单选就出单选。
 *
 * 跨工作区（D18）：状态在后端，切到哪个区都能看见别的区在跑什么。
 */

export type Bubble = {
  id: string
  workspace_id?: string | null
  ws_name?: string | null
  session_id?: string | null
  title?: string | null
  state: 'running' | 'done' | 'ask' | 'error'
  level: 'light' | 'heavy'
  tools: number
  last_tool?: string | null
  question?: string | null
  ask?: Ask | null
  updated: number
}

const STATE_CN: Record<string, string> = {
  running: '正在跑',
  done: '完成',
  ask: '需要你答',
  error: '出错',
}

export function useBubbles(pollMs = 4000) {
  const [items, setItems] = useState<Bubble[]>([])
  const pull = useCallback(async () => {
    try {
      const d = await fetch('/api/bubbles').then((r) => r.json())
      setItems((d?.items || []) as Bubble[])
    } catch { /* 抖一下不影响主流程 */ }
  }, [])
  useEffect(() => {
    pull()
    const t = setInterval(pull, pollMs)
    return () => clearInterval(t)
  }, [pull, pollMs])
  return { items, pull }
}

export function Bubbles({
  items, onJump, onRefresh,
}: {
  items: Bubble[]
  /* 点气泡跳回那条会话（D18「点击可跳回对应会话」） */
  onJump?: (b: Bubble) => void
  onRefresh?: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  /* done 只留 8 秒就自己消失 —— 完成了不需要一直提醒 */
  const visible = items.filter(
    (b) => b.state !== 'done' || Date.now() / 1000 - b.updated < 8)

  useEffect(() => {
    if (openId && !visible.some((b) => b.id === openId)) setOpenId(null)
  }, [openId, visible])

  const dismiss = async (id: string) => {
    await fetch('/api/bubbles/' + encodeURIComponent(id) + '/dismiss', { method: 'POST' })
      .catch(() => {})
    onRefresh?.()
  }

  /* 在气泡里答完：清掉气泡，并把答案送回那条会话。
     现在统一交给 onJump —— 答案要在真正的输入框里发出去，
     气泡只负责「让你看见有事要答」。 */
  const answered = async (b: Bubble, text: string) => {
    await dismiss(b.id)
    onJump?.(b)
    // 交给对话区去发：同一个 send 通道，不另造一份
    setTimeout(() => window.dispatchEvent(
      new CustomEvent('sd:answer', { detail: { session: b.session_id, text } })), 60)
  }

  if (!visible.length) return null

  return (
    <div className="bubwrap" ref={wrapRef}>
      {visible.map((b) => {
        const open = openId === b.id
        const running = b.state === 'running'
        return (
          <div className={'bub ' + b.state + (open ? ' open' : '')} key={b.id}>
            {/* 轻打扰：只有一个点和一行字 */}
            <button className="bub-line" onClick={() => setOpenId(open ? null : b.id)}>
              <span className={'bub-dot' + (running ? ' live' : '')} />
              <span className="bub-txt">
                {STATE_CN[b.state] || b.state}
                {running && b.tools ? <em>· {b.tools} 个工具</em> : null}
                {b.state === 'ask' && b.ws_name ? <em>· {b.ws_name}</em> : null}
              </span>
              {open ? <Icon n="chev" size={10} className="bub-cv" /> : null}
            </button>

            {/* 重打扰：要你答时才展开，而且用的是同一个提问卡 */}
            {open ? (
              <div className="bub-body">
                {b.title ? <div className="bub-title">{b.title}</div> : null}

                {b.state === 'ask' ? (
                  b.ask && (b.ask.groups?.length || b.ask.options?.length)
                    ? <div className="bub-askbox">
                        <AskBox a={b.ask} onSend={(t) => answered(b, t)} />
                      </div>
                    : <div className="bub-plainask">
                        <p>{b.question || '有件事想问你'}</p>
                        <button className="bub-go" onClick={() => { onJump?.(b); setOpenId(null) }}>
                          去对话里回答
                        </button>
                      </div>
                ) : null}

                {running ? (
                  <div className="bub-prog">
                    {b.last_tool ? <span>{b.last_tool}</span> : <span>在算…</span>}
                  </div>
                ) : null}

                <div className="bub-foot">
                  {b.session_id ? (
                    <button className="bub-go" onClick={() => { onJump?.(b); setOpenId(null) }}>
                      回到会话
                    </button>
                  ) : null}
                  <div className="sp" />
                  <button className="bub-x2" onClick={() => dismiss(b.id)}>知道了</button>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
