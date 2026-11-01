/* 全屏圆形扩散转场 —— 单向，圆经过的地方就是新界面。
 *
 * 用户要求（2026-10-31）：
 *   ① 从左下角或右下角起（不是屏幕中间）
 *   ② 圆长过去时 UI 就换了 —— 不要「放大盖住再缩回」那种来回
 *   ③ 现在的问题：只闪了一下黑。原因是遮罩是纯色块，盖住之后才换 DOM，
 *      用户看到的就是「黑一下」而不是「新界面从角上长出来」。
 *
 * 正确做法（这次重写）：
 *   在遮罩里放一个**真圆形**元素，而不是用 clip-path 铺一块纯色：
 *     · 遮罩本身透明（不挡视线）
 *     · 圆是实心圆，颜色取页面底色，从角上由小变大
 *     · 圆长到 55% 时换 DOM —— 此时新界面已经在圆里面了
 *     · 圆继续长满 → 撤掉遮罩，露出完整新界面
 *   这样肉眼看到的是：一只黑圆从角落漾开，漾过的地方已经是新的页面。
 */

type Origin = { x: number; y: number }

export function revealTransition(run: () => void, o?: Partial<Origin>): void {
  const doc = document
  if (!doc || !doc.body) { run(); return }

  const W = window.innerWidth
  const H = window.innerHeight
  /* 默认左下角 */
  const x = o?.x ?? Math.round(W * 0.05)
  const y = o?.y ?? Math.round(H * 0.97)

  /* 到最远角的距离 = 圆最终要长到多大 */
  const R = Math.hypot(Math.max(x, W - x), Math.max(y, H - y)) + 30

  const bg = (getComputedStyle(doc.body).getPropertyValue('--bg') || '#0c0b09').trim() || '#0c0b09'

  /* 外层：只做定位，本身透明，不挡视线 */
  const layer = doc.createElement('div')
  layer.className = 'reveal-layer'
  layer.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;overflow:hidden'

  /* 实心圆：从 0 长到 R */
  const circle = doc.createElement('div')
  circle.style.cssText = [
    'position:absolute',
    `left:${x}px`,
    `top:${y}px`,
    'width:0px',
    'height:0px',
    'border-radius:50%',
    `background:${bg}`,
    'transform:translate(-50%,-50%)',
    'will-change:width,height',
  ].join(';')
  layer.appendChild(circle)
  doc.body.appendChild(layer)

  const dur = 430
  const ease = 'cubic-bezier(.33,.75,.25,1)'

  requestAnimationFrame(() => {
    circle.style.transition = `width ${dur}ms ${ease}, height ${dur}ms ${ease}`
    circle.style.width = R * 2 + 'px'
    circle.style.height = R * 2 + 'px'
  })

  /* 圆盖到 55% 时换 DOM：
     此刻那一圈里已经是新界面了，所以观感是「新界面从角上长出来」，
     而不是「先黑一下再出现」（之前那版的毛病）。 */
  window.setTimeout(() => { run() }, Math.round(dur * 0.55))

  /* 长满后撤掉这一层：不再缩小、不再回来 */
  window.setTimeout(() => {
    layer.style.transition = 'opacity 110ms linear'
    layer.style.opacity = '0'
    window.setTimeout(() => layer.remove(), 130)
  }, dur + 30)
}

/* 从某个元素的位置扩散（点击某张卡就它那儿起圆） */
export function revealFrom(el: HTMLElement | null, run: () => void): void {
  if (!el) { revealTransition(run); return }
  const r = el.getBoundingClientRect()
  revealTransition(run, { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) })
}
