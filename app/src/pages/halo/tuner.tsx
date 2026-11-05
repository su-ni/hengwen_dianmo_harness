/* ============================================================
   调参面板 —— 官方 lab.html 里那 56 个参数，做成能实时拖的界面。

   为什么不照搬官方那块 CONSOLE：
     · 官方是给作者自己调稿用的，一屏 56 个滑块糊在一起；
     · 我们这页是**整屏控制台**，再开一栏会把光环挤没。
   所以做成右上角浮层，默认收起，按「调参」才展开。

   关键：所有滑块只调 engine.setParam(k,v)，**不重建引擎**。
   重建会把正在跑的光束全部掐掉，界面一闪 —— 那不是调参，是重启。
   ============================================================ */
import { useState } from 'react'
import { PARAM_GROUPS, PARAM_META, type ParamMeta } from './engine'

type Props = {
  get: () => Record<string, number>
  set: (k: string, v: number) => void
  reset: () => void
}

const META: Record<string, ParamMeta> = Object.fromEntries(PARAM_META.map(m => [m.key, m]))

export function Tuner({ get, set, reset }: Props) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(0)
  const [, setTick] = useState(0)

  if (!open) {
    return <button className="hfx-tune-btn" onClick={() => setOpen(true)} title="调参（56 个参数）">调参</button>
  }

  const g = PARAM_GROUPS[group]
  const cur = get()

  return (
    <div className="hfx-tuner">
      <div className="hfx-tuner-hd">
        <b>调参 · {PARAM_META.length} 项</b>
        <div className="hfx-tuner-act">
          <button onClick={() => { reset(); setTick(t => t + 1) }}>复位</button>
          <button onClick={() => setOpen(false)}>收起</button>
        </div>
      </div>

      <div className="hfx-tuner-tabs">
        {PARAM_GROUPS.map((x, i) => (
          <button key={x.name} className={i === group ? 'on' : ''} onClick={() => setGroup(i)}>{x.name}</button>
        ))}
      </div>

      <div className="hfx-tuner-body">
        {g.keys.map(k => {
          const m = META[k]
          if (!m) return null
          const v = cur[k] ?? 0
          return (
            <label className="hfx-tuner-row" key={k}>
              <span className="k" title={k}>{k}</span>
              <input
                type="range" min={m.min} max={m.max} step={m.step} value={v}
                onChange={e => { set(k, Number(e.target.value)); setTick(t => t + 1) }}
              />
              <span className="v">{Number(v).toFixed(2)}</span>
            </label>
          )
        })}
      </div>
      <div className="hfx-tuner-ft">拖动即时生效 · 不重建引擎 · 复位回到当前模式预设</div>
    </div>
  )
}
