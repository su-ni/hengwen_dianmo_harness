import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/* 对话轮次导航轨（turn rail）—— 对齐 DeepSeek Harness 的做法。
 *
 * 它不是推理滑条的刻度，而是**对话历史的一根竖向刻度尺**：
 *   · 每个圆点/短线 = 一个轮次（user 提问 + 助手那一整轮）
 *   · 间距固定 10px（轮次少时也均匀分布，不按内容长度拉伸）
 *   · 鼠标悬停 → 右侧浮出该轮首句预览
 *   · 点击 → 滚到那一轮（对应消息元素加 data-turn 锚点）
 *   · 当前位置高亮：视口里正显示的那几轮亮起来
 *
 * 放在对话区右侧、贴着滚动区，不占正文宽度。
 */

export type TurnMark = {
  n: number            // 第几轮（从 1 开始），对应 data-turn={n}
  text: string         // 轮次预览（第一条用户消息截断）
}

const TICK_GAP = 10

export function TurnRail({
  turns, onJump, activeN,
}: {
  turns: TurnMark[]
  onJump: (n: number) => void
  /* 当前视口中心所在的轮次；没有就传 null */
  activeN?: number | null
}) {
  const [hover, setHover] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [topGap, setTopGap] = useState(0)

  /* 轮次太多时轨道会超长：按可用高度压缩间距，保证整根尺子在视口内 */
  const layout = useMemo(() => {
    const count = turns.length
    if (!count) return { gap: TICK_GAP, height: 0 }
    const natural = (count - 1) * TICK_GAP
    const maxH = 420                      // 与 DSH 一致：最高 420px
    const gap = count > 1 ? Math.min(TICK_GAP, maxH / (count - 1)) : TICK_GAP
    return { gap, height: Math.max(0, (count - 1) * gap) }
  }, [turns.length])

  const jump = useCallback((n: number) => {
    const el = document.querySelector('[data-turn="' + n + '"]') as HTMLElement | null
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    onJump(n)
  }, [onJump])

  useEffect(() => {
    // 轨道垂直居中时不压住 composer：DSH 用 turn-rail-band 算可用高度
    setTopGap(0)
  }, [])

  if (!turns.length) return null

  return (
    <div className="rail-turn" ref={railRef}>
      <div className="rt-rail" style={{ height: layout.height + topGap }}>
      {turns.map((t, i) => {
        const y = i * layout.gap
        const on = activeN === t.n
        const hov = hover === t.n
        return (
          <div
            key={t.n}
            className={'rt-item' + (on ? ' on' : '') + (hov ? ' hov' : '')}
            style={{ top: y }}
            onMouseEnter={() => setHover(t.n)}
            onMouseLeave={() => setHover((h) => (h === t.n ? null : h))}
            onClick={() => jump(t.n)}
            role="button"
            tabIndex={0}
            aria-label={'第 ' + t.n + ' 轮：' + (t.text || '')}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') jump(t.n) }}
          >
            <i className="rt-dot" aria-hidden="true" />
            {hov ? (
              <div className="rt-pop">
                <b>第 {t.n} 轮</b>
                <span>{t.text || '（无正文）'}</span>
              </div>
            ) : null}
          </div>
        )
      })}
      </div>
    </div>
  )
}

/* 从一串消息里抽出轮次标记：user 消息开一轮，后面的助手内容归它。 */
export function turnsOf(msgs: { role: string; text?: string }[]): TurnMark[] {
  const out: TurnMark[] = []
  let n = 0
  for (const m of msgs) {
    if (m.role !== 'user') continue
    n += 1
    const t = String(m.text || '').replace(/\s+/g, ' ').trim()
    out.push({ n, text: t.length > 60 ? t.slice(0, 58) + '…' : t })
  }
  return out
}
