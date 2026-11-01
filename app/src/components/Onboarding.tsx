import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { Logo } from './Logo'

/* 新手引导：第一次打开时走一遍，之后不再出现。
 *
 * 为什么是「三步 + 一张卡」而不是一堆提示气泡：
 *   第一次来的人只有两个疑问 ——「这是干什么的」「我该从哪开始」。
 *   答完这两个就够了。引导太长，人会直接关掉，反而什么都没看到。
 *
 * 记住用后端 kv（`app.onboarded`），不用 localStorage：
 *   换浏览器/清缓存后不该再被引导一遍，而「这台机器上我用过了」才是对的口径。
 */

const STEPS = [
  {
    t: '这里是你的学习工作台',
    d: '一次学习任务 = 一个工作区。专升本、考研、学摄影，各开一个，互不打扰。',
    icon: 'stack',
  },
  {
    t: '你不用填表，直接说',
    d: '「我要考专升本，明年三月」「这周英语怎么复习」—— 它会问你缺的那几件事，然后去排。',
    icon: 'agent',
  },
  {
    t: '它会真的动手',
    d: '找课、入库、排课、出题都是它自己调工具做的。右边会实时显示它调了什么、查到什么。',
    icon: 'practice',
  },
]

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0)
  const [busy, setBusy] = useState(false)

  async function finish() {
    if (busy) return
    setBusy(true)
    try {
      await fetch('/api/onboard', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ done: true }),
      })
    } catch { /* 记不住也不该卡住人 */ }
    setBusy(false)
    onDone()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      else if (e.key === 'Enter') {
        if (i < STEPS.length - 1) setI(i + 1)
        else finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, busy])

  const s = STEPS[i]
  const last = i === STEPS.length - 1

  return (
    <div className="obwrap">
      <div className="obcard">
        <div className="obhead">
          <Logo size={22} tone="white" />
          <b>衡文点墨</b>
          <span className="obstep">{i + 1} / {STEPS.length}</span>
          <button className="obskip" onClick={finish} disabled={busy}>跳过</button>
        </div>

        <div className="obbody">
          <div className="obic"><Icon n={s.icon} size={26} /></div>
          <h3>{s.t}</h3>
          <p>{s.d}</p>
        </div>

        <div className="obfoot">
          <div className="obdots">
            {STEPS.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}
          </div>
          <div className="sp" />
          {i > 0 ? (
            <button className="btn sm" onClick={() => setI(i - 1)} disabled={busy}>上一步</button>
          ) : null}
          <button
            className="btn sm act"
            onClick={() => (last ? finish() : setI(i + 1))}
            disabled={busy}
          >
            {last ? (busy ? '好了…' : '开始用') : '下一步'}
          </button>
        </div>
      </div>
    </div>
  )
}
