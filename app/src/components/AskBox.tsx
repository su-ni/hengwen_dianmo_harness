import { useRef, useState } from 'react'

/* 提问卡：模型问几件事，人在这里勾 + 自己写，一次发回去。
 *
 * 为什么抽成独立组件：它同时用在两个地方 ——
 *   1. 对话流里（历史记录里回看当时的提问）
 *   2. 气泡通知里（在别的页面也能直接答，D21）
 * 两处必须是同一个东西，各写一份必然长歪。
 */

export type AskOpt = { label: string; value: string }
/* 一组问题。模型一轮问几样就有几组 —— 都在同一个框里问完、一次发出去。 */
export type AskGroup = { question: string; options: AskOpt[]; multi: boolean; hint?: string }
export type Ask = {
  /* 单组时用这两个（老格式，后端也还这么给）；多组时看 groups。 */
  question?: string
  options?: AskOpt[]
  multi?: boolean
  groups?: AskGroup[]
  hint?: string
}

function AskBox({ a, locked, onSend }: { a: Ask; locked?: boolean; onSend: (txt: string) => void }) {
  const groups: AskGroup[] = a.groups && a.groups.length
    ? a.groups
    : [{ question: a.question || '', options: a.options || [], multi: !!a.multi }]
  /* picked[i]：第 i 组勾中的 value 列表；extra[i]：第 i 组人自己打的字。 */
  const [picked, setPicked] = useState<string[][]>(() => groups.map(() => []))
  const [extra, setExtra] = useState<string[]>(() => groups.map(() => ''))

  const toggle = (gi: number, v: string) => {
    if (locked) return
    setPicked((p) => {
      const n = p.map((x) => x.slice())
      const cur = n[gi] || []
      if (groups[gi].multi) {
        n[gi] = cur.indexOf(v) >= 0 ? cur.filter((x) => x !== v) : cur.concat([v])
      } else {
        n[gi] = cur[0] === v ? [] : [v]   /* 单选框再点一下能取消 —— 选错了得有退路 */
      }
      return n
    })
  }
  /* 人自己写的字也留一份在 ref 里：React 的 setState 是异步的，
     手快的人写完立刻按 Enter，这一帧 extra 还是旧的，会被判成「没答」。
     两个来源都算数，就不怕先后顺序。 */
  const extraRef = useRef<string[]>(groups.map(() => ''))
  const setEx = (gi: number, s: string) => {
    extraRef.current[gi] = s
    setExtra((p) => { const n = p.slice(); n[gi] = s; return n })
  }

  /* 一组里有几样都算「答了」：勾了选项，或者自己写了字。 */
  const filled = (gi: number) =>
    (picked[gi] || []).length > 0 || (extra[gi] || '').trim().length > 0 ||
    (extraRef.current[gi] || '').trim().length > 0
  const ready = groups.length > 0 && groups.every((_, gi) => filled(gi))
  const nth = groups.length > 1 ? groups.filter((_, gi) => filled(gi)).length : 0

  /* 拼成一句话发回去。一组一问就原样给答案；多组就「问：答」分行 ——
     模型看得懂，人也看得懂自己刚发了什么。 */
  const submit = () => {
    if (!ready || locked) return
    const lines: string[] = []
    groups.forEach((g, gi) => {
      const parts: string[] = []
      const pk = picked[gi] || []
      if (pk.length) parts.push(pk.join('、'))
      const ex = ((extra[gi] || '') || (extraRef.current[gi] || '')).trim()
      if (ex) parts.push(ex)
      if (!parts.length) return
      const ans = parts.join('；')
      lines.push(groups.length > 1 && g.question ? g.question + '：' + ans : ans)
    })
    if (lines.length) onSend(lines.join('\n'))
  }

  return (
    <div className={'cask' + (locked ? ' locked' : '')}>
      {groups.map((g, gi) => (
        <div className="cask-g" key={gi}>
          <b className="cask-q">
            {groups.length > 1 && <span className="cask-no">{gi + 1}</span>}
            {g.question || '想清楚了吗'}
            <em className="cask-tag">{g.multi ? '可多选' : '单选'}</em>
          </b>
          {g.options.length > 0 && (
            <div className="cask-opts">
              {g.options.map((o) => {
                const on = (picked[gi] || []).indexOf(o.value) >= 0
                return (
                  <button
                    key={o.value}
                    className={'cask-opt' + (on ? ' on' : '')}
                    disabled={locked}
                    onClick={() => toggle(gi, o.value)}
                  >
                    <span className="cask-box" data-on={on ? '1' : '0'} data-multi={g.multi ? '1' : '0'} />
                    {o.label}
                  </button>
                )
              })}
            </div>
          )}
          {/* 选项里没有的那一条：人自己有话说。这是「完整提问」，不是猜谜。 */}
          {!locked && (
            <input
              className="cask-in"
              value={extra[gi] || ''}
              placeholder={g.hint || (g.options.length ? '或者自己写' : '自己写一句：日期、时长、科目都行')}
              onChange={(e) => setEx(gi, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
          )}
        </div>
      ))}
      <div className="cask-ft">
        <span className="cask-n">
          {locked ? '已经发出去了'
            : !ready ? (groups.length > 1 ? '还有 ' + (groups.length - nth) + ' 个没答' : '选一个，或者自己写')
              : groups.length > 1 ? groups.length + ' 个都答了' : '可以发'}
        </span>
        <div className="sp" />
        <button className="btn sm act" onClick={submit} disabled={!ready || locked}>
          {locked ? '已发送' : '发出去'}
        </button>
      </div>
    </div>
  )
}

export { AskBox }
