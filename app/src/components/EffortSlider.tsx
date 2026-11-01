import { useCallback, useEffect, useRef, useState } from 'react'

/* 推理等级滑条 —— 复刻 dsh-codex-effort-slider 的几何。
 *
 * 为什么不用 <input type="range">：
 *   原生 range 的 thumb 尺寸/边距会被浏览器重算，结果就是「白点浮在条外面」。
 *   参考实现全用普通元素 + JS 算像素位置，所以旋钮永远贴死在轨道里。
 *
 * 关键几何（之前对不齐、超界的根因都在这里）：
 *   ① 轨道高 28px，旋钮直径 = 28px（完整填满管口，不被裁成平边）。
 *   ② 旋钮**圆心**的可移动范围不是 0..轨道宽，而是
 *      [knob/2, 轨道宽 - knob/2] —— 两端各留半个旋钮。
 *      否则最右端（100%）时圆心压在右边缘，半个圆伸到轨道外（截图里就是这样）。
 *   ③ 刻度点落在同一条内缩线上，才与旋钮圆心严格对齐。
 *   ④ 档位切换按「圆心坐标」判断最近档，不按百分比 —— 两端内缩后百分比会偏。
 */

type Lv = { k: string; label: string; why?: string }

const TRACK_H = 28
const KNOB = TRACK_H
const HALF = KNOB / 2
const STARS = 18

function hash01(i: number, salt: number) {
  const v = ((i + 1) * salt * 2654435761) % 4294967296
  return ((v >>> 8) % 1000) / 1000
}

export function EffortSlider({
  levels, value, disabled, onChange,
}: {
  levels: Lv[]
  value: string
  disabled?: boolean
  onChange: (k: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)   // 拖动中的连续档位 0..n-1
  const [trackW, setTrackW] = useState(0)
  const n = Math.max(1, levels.length)
  const idx = Math.max(0, levels.findIndex((x) => x.k === value))

  const travel = Math.max(0, trackW - KNOB)              // 圆心可移动行程

  /** 第 i 档圆心相对轨道左边缘的像素位置 */
  const xOf = useCallback((i: number) => {
    if (n <= 1) return HALF + travel
    return HALF + (i / (n - 1)) * travel
  }, [n, travel])

  const cur = Math.max(0, Math.min(n - 1, Math.round(drag != null ? drag : idx)))

  const ev = Math.max(0, Math.min(1, (n <= 1 ? 1 : cur / (n - 1) - 1 / 3) / (1 - 1 / 3)))
  const starCount = Math.round(ev * STARS)
  const energyOn = ev > 0.01

  /** 指针 x → 连续档位 */
  const idxAt = useCallback((clientX: number) => {
    const el = wrapRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const rel = Math.min(1, Math.max(0, (clientX - r.left - HALF) / Math.max(1, travel)))
    return rel * (n - 1)
  }, [n, travel])

  const commit = (i: number) => {
    const k = Math.max(0, Math.min(n - 1, Math.round(i)))
    if (levels[k] && levels[k].k !== value) onChange(levels[k].k)
  }

  const onDown = (e: React.PointerEvent) => {
    if (disabled || !levels.length) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    const i = idxAt(e.clientX)
    setDrag(i); commit(i)
  }
  const onMove = (e: React.PointerEvent) => {
    if (disabled || drag == null) return
    const i = idxAt(e.clientX)
    setDrag(i); commit(i)          /* 拖过边界即切档，不等松手 */
  }
  const onUp = (e: React.PointerEvent) => {
    if (disabled) return
    setDrag(null)
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled || !levels.length) return
    let next: number | null = null
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, idx - 1)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n - 1, idx + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    if (next == null) return
    e.preventDefault(); commit(next)
  }

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setTrackW(el.getBoundingClientRect().width)
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  useEffect(() => {
    if (drag == null) return
    const up = () => setDrag(null)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag])

  const knobX = drag != null
    ? HALF + Math.min(1, Math.max(0, drag / Math.max(1, n - 1))) * travel
    : xOf(idx)
  const fillW = knobX

  return (
    <div
      ref={wrapRef}
      className={'cs-track' + (disabled ? ' is-off' : '')}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="推理等级"
      aria-valuemin={0}
      aria-valuemax={n - 1}
      aria-valuenow={cur}
      aria-valuetext={levels[cur]?.label || ''}
      style={{ height: TRACK_H }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onKeyDown={onKey}
    >
      <div className="cs-fill" style={{ width: fillW + 'px' }} />

      {energyOn ? (
        <>
          <div className="cs-energy" style={{ width: fillW + 'px', opacity: ev }} aria-hidden="true">
            <div className="cs-sweep" />
          </div>
          <div className="cs-stars" style={{ width: fillW + 'px', opacity: 0.55 + 0.45 * ev }} aria-hidden="true">
            {Array.from({ length: starCount }).map((_, i) => {
              const dur = 2.6 + hash01(i, 29) * 1.6
              const delay = -hash01(i, 53) * dur
              const bright = 0.45 + hash01(i, 61) * 0.55
              const top = 18 + hash01(i, 83) * 64
              return (
                <i
                  key={i}
                  className="cs-star"
                  style={{
                    top: top + '%',
                    animationDuration: dur + 's',
                    animationDelay: delay + 's',
                    ['--b' as any]: bright,
                    ['--travel' as any]: (travel || 240) + 'px',
                  }}
                />
              )
            })}
          </div>
        </>
      ) : null}

      {levels.map((l, i) => (
        <span
          key={l.k}
          className={'cs-tick' + (i <= cur ? ' on' : '')}
          style={{ left: xOf(i) + 'px' }}
          aria-hidden="true"
        />
      ))}

      <div
        className="cs-knob"
        style={{ width: KNOB, height: KNOB, left: knobX - HALF + 'px', top: (TRACK_H - KNOB) / 2 }}
        aria-hidden="true"
      />
    </div>
  )
}
