/* ============================================================
   halo/engine.ts —— HALOFLUX 引擎本体（Canvas，无 React、无 DOM 依赖）

   来源：web/halo/lab.html（Ryder191 / HALOFLUX，PolyForm Noncommercial 1.0.0）
   这里做的是**移植**不是重画：节拍时钟、圈内网线、跑步光线、成组光束、
   圆环数据块、五层伸缩光束、飞出流线、呼吸雾带、自动运镜、辉光合成 ——
   官方那套 56 个参数的机制一个不少地搬了过来。

   改了三件事，其余照旧：
     1. 颜色：全部走 theme.ts 的调色板（系统配色，不是官方冷白）
     2. 数据：官方那些假的论文/方法数字，换成「研学台」的真实东西
     3. 钩子：strokes 和 stars 两种数据源，让同一个引擎既能演「正在做什么」，
        也能演「记得什么」。两副面孔、一套骨架 —— 这是它们能融在一起的原因。

   性能上的取舍（照抄官方又做了收敛）：
     · 圈内网线是**预渲染**到离屏 canvas 的，不是每帧重画 2600 条贝塞尔
     · 跑步光线用一条 trail canvas 做 destination-out 淡出，不是留历史点
     · 远景光束画进半分辨率 buffer 再模糊合成（景深）
     · 辉光整屏走 1/3 分辨率再放大，最贵的一步只花 1/9 的像素
   ============================================================ */

import { makePalette, type Palette, type MemKind, type RGB } from './theme'

const TAU = Math.PI * 2
const rnd = Math.random
const rr = (a: number, b: number) => a + rnd() * (b - a)
const pick = <T,>(a: T[]): T => a[(rnd() * a.length) | 0]
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const normA = (a: number) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const easeO = (t: number) => 1 - Math.pow(1 - t, 3)
const easeOX = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
const hash = (x: number) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s) }
/* 字符串用的稳定哈希：同一条记忆永远拿到同一个相位，刷新不跳 */
const hashS = (str: string) => {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 10000) / 10000
}

/* 数据块里的小字用等宽：官方也是等宽，块面才不会跟着缩放抖 */
const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace'

/* ---------- 一个画布对的薄封装（官方 mkd / fit 的等价物） ---------- */
type Cv = HTMLCanvasElement & { x: CanvasRenderingContext2D; w?: number; h?: number }

function mk(w: number, h: number, d: number): Cv {
  const c = document.createElement('canvas') as Cv
  c.width = Math.max(1, Math.ceil(w * d)); c.height = Math.max(1, Math.ceil(h * d))
  c.x = c.getContext('2d') as CanvasRenderingContext2D
  c.x.setTransform(d, 0, 0, d, 0, 0)
  c.w = w; c.h = h
  return c
}

/* ---------- 参数：官方那 56 个一个不少，默认值是作者定稿的 MINE ---------- */
export type Params = Record<string, number>

const BASE: Params = {
  tempo: 1, camera: 1, camZoom: 1, glow: 1, scan: 1,
  ringSpeed: 1, ringPause: 1, ringWidth: 1, rimBright: 1, rimWidth: 1, dataFlicker: 1,
  webBright: 1, webPulseBase: 0.15, webPulseAmp: 0.85, webSpin: 1,
  runnerCount: 336, runnerBright: 1, runnerWidth: 1, runnerSpeed: 1, runnerVariety: 1,
  cometPerBeat: 1.1, cometBurst: 4, cometTrickle: 0, cometLines: 1, cometWidth: 1,
  cometBright: 1, cometGlow: 1.1, cometSpeed: 1, cometFollow: 0,
  beamBright: 1, beamBounce: 1, beamLen: 1, beamWidth: 1, beamGlow: 1, dashBright: 1,
  hazeCount: 8, hazeBright: 1,
  flyerCount: 1, flyerBright: 1, flyerWidth: 1, flyerSpeed: 1, burstRate: 1, burstSize: 1,
  burstBright: 1, flareRate: 1, flareBright: 1,
  rimDensity: 1, depthBlur: 1.4, depthDim: 0.9, webBlur: 0.7, parallax: 0.6,
  bokeh: 16, bokehBright: 1, atmos: 1, ringShadow: 1, vignette: 0.7,
}

/* 作者在 lab.html:281 烘焙的那套默认（他调了一整天定的稿）。
   我们照用 —— 那是这套动画之所以好看的原因，不是我该「优化」的地方。 */
const BAKED: Params = {
  tempo: 2.5, camera: 1, camZoom: 1, glow: 1.1, scan: 1, ringSpeed: 3, ringPause: 1.2,
  ringWidth: 1.3, rimBright: 1.8, rimWidth: 1.3, dataFlicker: 1, webBright: 0.9,
  webPulseBase: 0.1, webPulseAmp: 0.8, webSpin: 1, runnerCount: 788, runnerBright: 0.5,
  runnerWidth: 1, runnerSpeed: 0.6, runnerVariety: 0.4, cometPerBeat: 2.3, cometBurst: 9,
  cometTrickle: 1.5, cometLines: 1, cometWidth: 1, cometBright: 1, cometGlow: 1.1,
  cometSpeed: 0.8, cometFollow: 1, beamBright: 1.8, beamLen: 1.8, beamWidth: 0.7,
  beamBounce: 2, beamGlow: 3.5, dashBright: 1.9, hazeCount: 22, hazeBright: 1.5,
  flyerCount: 3, flyerBright: 3, flyerWidth: 1.4, flyerSpeed: 2.2, burstRate: 3.5,
  burstSize: 3, burstBright: 2.5, flareRate: 3.5, flareBright: 2, rimDensity: 1.2,
  depthBlur: 0, depthDim: 0.1, webBlur: 0, parallax: 0, bokeh: 0, bokehBright: 0,
  atmos: 0, ringShadow: 0, vignette: 0,
}

/* 运行时那副面孔：比默认再收一点，因为它是**一直开着**的背景，不是演示。
   tempo 2.5 那档是给人看三十秒的，挂一天会把眼睛磨坏。 */
const LIVE_PRESET: Params = {
  ...BAKED, tempo: 1.15, ringSpeed: 1.5, glow: 0.9, cometTrickle: 0.5,
  camera: 1, camZoom: 0.32,         // 推近幅度压到三分之一：4:3 里推到 2.8 倍会把环整个推出画面
  beamBright: 1.25, hazeCount: 16, hazeBright: 1.25,
  flyerCount: 0.55,                 // 750 条飞出流线在 4:3 里就是一片白毛，收掉
  burstRate: 1.1, burstSize: 1.4, burstBright: 1.5, flareRate: 1.4,
  runnerCount: 520, webBright: 0.62,
  vignette: 0.6, atmos: 0.8, ringShadow: 0.9,
  depthDim: 0.5, depthBlur: 1.4,    // 远层不能压到看不见，虚化是这套光的「空气」
}

/* 星图那副面孔：光要更少、更慢，因为前景要放几百个记忆节点。
   光束一多，节点就淹了 —— 这一版的主角是节点。 */
const STAR_PRESET: Params = {
  ...BAKED, tempo: 0.6, ringSpeed: 0.7, ringPause: 3.2, glow: 0.55, camera: 1, camZoom: 0.1,
  /* 记忆场是这一屏的主角，光环降成**极薄的底噪** ——
     它还活着（能看出机器在运转），但不许跟记忆抢眼睛。
     这组数值是从实测里定的：光束再亮一档，记忆块就被冲得看不清。 */
  webBright: 0.16, webPulseBase: 0.06, webPulseAmp: 0.2,
  runnerCount: 140, runnerBright: 0.12, runnerSpeed: 0.3,
  cometPerBeat: 0.4, cometBurst: 1, cometTrickle: 0.08, cometGlow: 0.5, cometBright: 0.4,
  beamBright: 0.16, beamLen: 0.8, beamBounce: 0.3, beamGlow: 0.8, dashBright: 0.2,
  hazeCount: 8, hazeBright: 0.45, flyerCount: 0.1, burstRate: 0.25, burstBright: 0.4,
  flareRate: 0.5, flareBright: 0.4, atmos: 0.45, ringShadow: 1.2, vignette: 0.75,
  depthDim: 0.28, depthBlur: 1.6, bokeh: 4, bokehBright: 0.3, ringWidth: 1.05,
}


/* ---------- 参数元信息：给调参面板用 ----------
   每个参数给一个合理范围和分组。范围不是随便定的：
   · 倍数类（bright/speed/width）0..3，0 是关掉、1 是原样、3 是拉满；
   · 数量类（count/bokeh）按官方调过的量级给上限；
   · 0..1 的开关类（dim/blur/vignette）保持 0..2。
   面板只改 C，不重建引擎 —— 重建会把正在跑的光束全部掐掉。 */
export type ParamMeta = { key: string; label: string; group: string; min: number; max: number; step: number }
export const PARAM_GROUPS: { name: string; keys: string[] }[] = [
  { name: '节拍与运镜', keys: ['tempo', 'camera', 'camZoom', 'glow', 'scan', 'vignette', 'atmos'] },
  { name: '环与数据块', keys: ['ringSpeed', 'ringPause', 'ringWidth', 'rimBright', 'rimWidth', 'rimDensity', 'dataFlicker', 'ringShadow'] },
  { name: '网与流光', keys: ['webBright', 'webPulseBase', 'webPulseAmp', 'webSpin', 'webBlur', 'runnerCount', 'runnerBright', 'runnerWidth', 'runnerSpeed', 'runnerVariety'] },
  { name: '彗星与光束', keys: ['cometPerBeat', 'cometBurst', 'cometTrickle', 'cometLines', 'cometWidth', 'cometBright', 'cometGlow', 'cometSpeed', 'cometFollow', 'beamBright', 'beamBounce', 'beamLen', 'beamWidth', 'beamGlow', 'dashBright'] },
  { name: '雾与飞线', keys: ['hazeCount', 'hazeBright', 'flyerCount', 'flyerBright', 'flyerWidth', 'flyerSpeed', 'burstRate', 'burstSize', 'burstBright', 'flareRate', 'flareBright', 'bokeh', 'bokehBright'] },
  { name: '景深', keys: ['depthBlur', 'depthDim', 'parallax'] },
]

const _RANGE: Record<string, [number, number, number]> = {
  tempo: [0.2, 4, 0.05], camera: [0, 2, 0.05], camZoom: [0, 1.2, 0.02],
  runnerCount: [0, 1200, 20], hazeCount: [0, 40, 1], flyerCount: [0, 6, 0.05],
  bokeh: [0, 40, 1], ringPause: [0.2, 5, 0.1], cometPerBeat: [0, 6, 0.1],
  cometBurst: [0, 20, 1], cometTrickle: [0, 5, 0.1], burstRate: [0, 8, 0.1],
  flareRate: [0, 8, 0.1], webPulseBase: [0, 0.5, 0.01], webPulseAmp: [0, 2, 0.05],
  vignette: [0, 2, 0.05], depthDim: [0, 2, 0.05], ringShadow: [0, 2, 0.05],
}
export const PARAM_META: ParamMeta[] = PARAM_GROUPS.flatMap(g =>
  g.keys.map(k => {
    const [min, max, step] = _RANGE[k] || [0, 3, 0.05]
    return { key: k, label: k, group: g.name, min, max, step }
  })
)

export const PRESETS = { mine: { ...BASE, ...BAKED }, live: { ...BASE, ...LIVE_PRESET }, star: { ...BASE, ...STAR_PRESET } }

/* ---------- 数据源 ---------- */
export type Stroke = { angle: number; strength: number; tone?: 0 | 1 | 2 }
export type FlashOpts = { dur?: number; tone?: 0 | 1 | 2 }

export type Star = {
  id: string
  kind: MemKind
  a: number                       // 极角（弧度）
  rad: number                     // 0..1，从圆心到外缘的相对半径
  size: number                    // 视觉重量 0.5..1.4
  label?: string
  fresh?: number                  // 新入场的淡入进度
}

export type StarLink = { from: string; to: string; rel?: string }

export type EngineMode = 'live' | 'star'

type Slot = { a: number; da: number; hpx: number; c: Cv | null; flash: number }
type Strand = {
  i0: number; n: number; base: number; len: number; kick: number
  ph: number; ph2: number; f1: number; f2: number
  lum: number; tint: number; lwK: number; lenS: number
  prof: number[]; pf: number[]; pp: number[]; ds: number[]; dsp: number; flow: number
  vis?: boolean
}
type StrandLayer = { step: number; rotK: number; lumK: number; lw: number; lenK: number; solidK: number; wedges: Strand[]; off: number; dyn: string }
type CometLine = { arc?: boolean; r?: number; a0?: number; span?: number; p0?: { x: number; y: number } | null; c?: { x: number; y: number }; p1?: { x: number; y: number } }
type Comet = { lines: CometLine[]; life: number; hit: boolean; rot0: number; dur: number; win: number; glow: boolean; tint: boolean }
type Runner = { cv: { p0: { x: number; y: number }; c: { x: number; y: number }; p1: { x: number; y: number } }; t: number; sp: number; mode: number; px: number; py: number; b: boolean }
type Flyer = { a: number; len: number; r: number; sp: number; lw: number; lv: number; tint: number; burst: boolean }
type Haze = { a: number; w: number; len: number; cur: number; age: number; life: number; alpha: number; tint: number; drift: number; seed?: number }
type Flare = { a: number; w: number; len: number; age: number; life: number; alpha: number; seed?: number }
type Bokeh = { x: number; y: number; r: number; a: number; vx: number; vy: number; st: number; ph: number }
type Pulse = { c: number; v: number; w: number; amp: number; life: number; L: number }
type Curve = { p0: { x: number; y: number }; c: { x: number; y: number }; p1: { x: number; y: number } }

/* ---------- 面板回调：把「画什么」留给页面，引擎只管什么时候要 ----------
   官方的八块面板里，有六块是画布的（对流、差分场、样本、索引…）。
   那些在研学台没有对应物 —— 硬搬过来就是纯装饰。这里只保留**有真数据**的钩子。 */
export type EngineHooks = {
  onBeat?: (beatN: number) => void
  onFrame?: (dt: number, t: number) => void
  onCamera?: (cam: { x: number; y: number; z: number }) => void
}

export class HaloEngine {
  readonly pal: Palette
  C: Params
  mode: EngineMode = 'live'

  /* 环上数据块原来全是 rnd() 拼的假数字（官方同口径：格式真实、数值示意）。
     这里允许外部注入**真实数**：记忆条数、工具数、掌握度、今日投入…
     facts 为空时自动退回随机，页面没数据时不至于报错。 */
  facts: Record<string, number> = {}
  private factKeys: string[] = []
  private factIx = 0

  private stage: HTMLCanvasElement
  private S: CanvasRenderingContext2D
  private layer: HTMLCanvasElement   // 承载全部的宿主画布（React 给的那块）
  private DPR = 1
  private W = 0; private H = 0
  private cx = 0; private cy = 0; private R = 0; private RO = 0; private RMAX = 0
  private thV = 0; private thS = 0

  private webBase!: Cv
  private webLayers: Cv[] = []
  private layerEnv = [0, 0, 0]
  private trailC!: Cv
  private glowC!: Cv
  private farC!: Cv
  private laneC!: Cv
  private GS = 3
  private FS = 0.5

  private curves: Curve[] = []
  private runners: Runner[] = []
  private comets: Comet[] = []
  private cards: Slot[] = []
  private strands: StrandLayer[] = []
  private hazes: Haze[] = []
  private flares: Flare[] = []
  private flyers: Flyer[] = []
  private flyBands: { a: number; w: number; life: number }[] = []
  private bokehs: Bokeh[] = []
  private bokehSpr: HTMLCanvasElement | null = null
  private pulses: Pulse[] = []
  private GR: Record<string, CanvasGradient> = {}

  private webRot = 0
  private ringRot = 0
  private rot = { from: 0, to: 0, t: 1, dur: 1, hold: 0, ease: easeIO }
  private OSTEP = 0.0038

  private beatT = 0.4
  private beatI = 0
  private sinceBeat = 9
  private beatN = 0
  private env = 0
  private T = 0

  private cam = { x: 0, y: 0, z: 1 }
  private shots: { x: number; y: number; z: number; hold: number }[] = []
  private shotI = 0
  private shotT = 0
  private camPhase: 'hold' | 'move' = 'hold'
  private camFrom: { x: number; y: number; z: number } | null = null

  /* 外部数据 */
  private stars: Star[] = []
  private starLinks: StarLink[] = []
  private starById = new Map<string, Star>()
  private starPulse = new Map<string, number>()   // 被点到的记忆 → 衰减亮度
  private strokes: Stroke[] = []

  private hooks: EngineHooks
  private raf = 0
  private last = 0
  private running = false
  private ro: ResizeObserver | null = null
  private ready = false

  constructor(canvas: HTMLCanvasElement, hooks: EngineHooks = {}) {
    this.stage = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('这个浏览器给不了 2d context')
    this.S = ctx
    this.layer = canvas
    this.pal = makePalette()
    this.C = { ...PRESETS.live }
    this.hooks = hooks
    this.mount()
  }

  /* ---------------- 生命周期 ---------------- */
  private mount() {
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => { this.resize() })
      this.ro.observe(this.stage)
    }
    this.resize()
    if (this.ready) this.start()
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const step = (now: number) => {
      if (!this.running) return
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.T += dt
      if (this.ready && this.W > 20 && this.H > 20) this.frame(dt)
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }

  stop() {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  destroy() {
    this.stop()
    this.ro?.disconnect()
    this.ro = null
  }

  /* 壁纸模式：让引擎缩到很低的速度继续呼吸，别把电池吃干 */
  setPaused(p: boolean) {
    if (p) this.stop(); else this.start()
  }

  /* ---------------- 尺寸 / 重建 ---------------- */
  private resize() {
    const r = this.stage.getBoundingClientRect()
    if (r.width < 20 || r.height < 20) { this.ready = false; return }
    this.DPR = Math.min(window.devicePixelRatio || 1, 2)
    this.W = r.width; this.H = r.height
    this.stage.width = Math.ceil(this.W * this.DPR)
    this.stage.height = Math.ceil(this.H * this.DPR)
    /* ---------- 构图：照官方，环切出画面 ----------
       官方 lab.html 的取景是：**圆心几乎贴住画布左边缘**，环撑到画布外，
       画面上只看到内弧一带 + 右半屏成束的光。那不是「没放好」，
       那正是它好看的来源 —— 一个巨大的结构从视野外掠过，你永远看不全它。

       我上一版把它缩成完整的一个圆，确实「放得下」了，但那个压迫感全没了。
       现在按官方的数值关系还原：
         · R  ≈ max(H*0.78, W*0.30)  → 环的直径比画布还高，上下自然切出去
         · cx ≈ W*0.07               → 圆心贴着左边，只露内弧
         · RO ≈ R + 带厚            → 外缘整个在画布右边之外
       唯一按我们画布微调的是 cx 的下限：窄屏时别把圆心推到负数，
       那样连内弧都看不见。 */
    this.R = Math.max(this.H * 0.78, this.W * 0.30)
    const band0 = Math.max(90, Math.min(240, this.H * 0.30, this.W * 0.13)) * this.C.ringWidth
    this.RO = this.R + band0
    /* 记忆模式下环要往左缩一点：右侧要腾给记忆场，环不能压过去。
       运行时模式还是官方的 cx≈W*0.07。 */
    this.cx = this.mode === 'star'
      ? Math.max(this.W * 0.01, this.W * 0.045)
      : Math.max(this.W * 0.02, this.W * 0.07)
    this.cy = this.H * 0.5
    this.RMAX = Math.hypot(this.W - this.cx, this.H / 2) + 60
    this.thV = Math.asin(Math.min(1, (this.H / 2 + 60) / this.R))
    this.thS = Math.asin(Math.min(1, (this.H / 2 + 40) / this.RO))

    this.buildWeb(); this.buildLanes(); this.buildCards(); this.buildOuter()
    this.trailC = mk(2 * this.R + 4, 2 * this.R + 4, Math.min(this.DPR, 1.5))
    this.farC = mk(this.W, this.H, this.FS <= 0 ? 1 : Math.max(0.25, Math.min(1, this.FS)))
    this.glowC = mk(Math.ceil(this.W / this.GS), Math.ceil(this.H / this.GS), 1)
    // 上面那两个是「像素尺寸已定」的缓冲，不能再用 mk 的 dpr 缩放
    this.farC.width = Math.ceil(this.W * this.FS); this.farC.height = Math.ceil(this.H * this.FS)
    this.farC.x = this.farC.getContext('2d') as CanvasRenderingContext2D
    this.glowC.width = Math.ceil(this.W / this.GS); this.glowC.height = Math.ceil(this.H / this.GS)
    this.glowC.x = this.glowC.getContext('2d') as CanvasRenderingContext2D

    this.runners = []
    for (let i = 0; i < this.C.runnerCount; i++) this.runners.push(this.newRunner(true))
    this.comets = []
    this.pulses = []
    this.buildShots()
    this.ready = true
  }

  private buildShots() {
    /* 官方的机位是按 1920×1080 全屏调的：推近 2.3~2.8 倍去「看环上的数据块」。
       在 4:3 的容器里，那个倍率会把环整个推出画面，只剩一片白线在飞。
       所以按**画布比例**压推近幅度，并且让「全景」机位多占时间 ——
       这一页是给人在干别的事时瞄一眼的，得看得见全貌。 */
    /* 机位围着**环心**做小幅呼吸，而不是跑到环外某些点上去凝视。
       官方的 2.3~2.8 倍是为了看清环上数据块的细节；
       这一页的用途是「瞄一眼就知道它在动」，所以全程能看见整圈，只做轻微推进。 */
    const wide = { x: this.W * 0.5, y: this.H * 0.5, z: 1 }
    const near = { x: this.cx + (this.W * 0.5 - this.cx) * 0.35, y: this.cy, z: 1 }
    this.shots = [
      { ...wide, hold: 7.5 },
      { ...near, z: 1.22, hold: 3.6 },
      { ...wide, hold: 4.0 },
      { x: this.cx, y: this.cy, z: 1.42, hold: 3.2 },
      { ...wide, hold: 4.2 },
      { ...near, z: 1.14, hold: 3.0 },
      { ...wide, hold: 3.4 },
    ]
    this.shotI = 0; this.shotT = 0; this.camPhase = 'hold'
    Object.assign(this.cam, this.shots[0])
  }

  /* ---------------- 圈内网线（预渲染） ---------------- */
  private buildWeb() {
    const size = 2 * this.R + 4
    const d = Math.min(this.DPR, 1.5)
    this.webBase = mk(size, size, d)
    this.webLayers = [0, 1, 2].map(() => mk(size, size, d))
    const all = [this.webBase, ...this.webLayers]
    all.forEach((c) => c.x.translate(this.R + 2, this.R + 2))
    const b = this.webBase.x
    const g = b.createRadialGradient(0, 0, this.R * 0.2, 0, 0, this.R)
    g.addColorStop(0, '#050506'); g.addColorStop(1, '#000000')
    b.fillStyle = g; b.beginPath(); b.arc(0, 0, this.R, 0, TAU); b.fill()
    all.forEach((c) => { c.x.save(); c.x.beginPath(); c.x.arc(0, 0, this.R, 0, TAU); c.x.clip() })

    const pal = this.pal
    this.curves = []
    /* 官方按画布面积给 1000~2600 条。半径缩下来以后同样的条数会挤成一团灰，
       所以这里按 **半径** 缩放：网线的观感密度取决于它在圆里有多挤，跟屏多大关系不大。 */
    const densK = Math.min(1.35, Math.max(0.35, (this.R / 560) ** 2))
    const N = Math.min(2600, Math.round((1000 + (this.W * this.H) / 800) * densK))
    for (let i = 0; i < N; i++) {
      const a1 = rnd() * TAU, a2 = a1 + rr(0.6, Math.PI * 1.4)
      const p0 = { x: Math.cos(a1) * this.R, y: Math.sin(a1) * this.R }
      const p1 = { x: Math.cos(a2) * this.R, y: Math.sin(a2) * this.R }
      const cr = Math.sqrt(rnd()) * this.R * 0.9, ca = rnd() * TAU
      const c = { x: Math.cos(ca) * cr, y: Math.sin(ca) * cr }
      this.curves.push({ p0, c, p1 })
      const layer = rnd() < 0.7 ? -1 : (rnd() * 3) | 0
      const x = layer < 0 ? b : this.webLayers[layer].x
      const al = Math.min(1, (layer < 0 ? 0.03 + Math.pow(rnd(), 3) * 0.28 : 0.08 + Math.pow(rnd(), 2) * 0.35) * this.C.webBright)
      const k = rnd()
      /* 官方的 5% 粉 + 5% 紫 → 我们的 5% 琥珀 + 5% 蓝（结构色） */
      const col: RGB = k < 0.05 ? pal.warm : k < 0.1 ? pal.lilac : pal.white
      x.strokeStyle = pal.rgba(col, al)
      x.lineWidth = rr(0.4, 1.1)
      x.beginPath(); x.moveTo(p0.x, p0.y); x.quadraticCurveTo(c.x, c.y, p1.x, p1.y); x.stroke()
    }
    // 节点标记 + 小环链（官方有，保留 —— 它们是「这是个图，不是星空」的暗号）
    b.textBaseline = 'middle'
    for (let i = 0; i < 70; i++) {
      const rr_ = Math.sqrt(rnd()) * this.R * 0.92, a = rnd() * TAU
      const px = Math.cos(a) * rr_, py = Math.sin(a) * rr_, s = rr(2, 4.5)
      b.strokeStyle = pal.rgba(pal.white, rr(0.35, 0.8)); b.lineWidth = 0.8
      b.beginPath(); b.arc(px, py, s, 0, TAU); b.stroke()
      if (rnd() < 0.4) { b.beginPath(); b.arc(px + s * 2.2, py, s * 0.8, 0, TAU); b.stroke() }
    }
    for (let k = 0; k < 3; k++) {
      const rad = this.R * rr(0.45, 0.85), a0 = rr(0, TAU), cnt = 22 + ((rnd() * 14) | 0)
      b.strokeStyle = pal.rgba(pal.white, 0.4); b.lineWidth = 0.8
      for (let i = 0; i < cnt; i++) { const a = a0 + i * 0.022; b.beginPath(); b.arc(Math.cos(a) * rad, Math.sin(a) * rad, 2.2, 0, TAU); b.stroke() }
    }
    all.forEach((c) => c.x.restore())
    /* 官方在这里做一次 blur 滤镜；我们不启用 —— 纯黑底上模糊只会糊掉细线，
       而且 filter 在部分机器上每帧重绘会掉到 30fps 以下。 */
  }

  /* ---------------- 跑步光线 ---------------- */
  private qpt(cv: Curve, t: number) {
    const u = 1 - t
    return {
      x: u * u * cv.p0.x + 2 * u * t * cv.c.x + t * t * cv.p1.x,
      y: u * u * cv.p0.y + 2 * u * t * cv.c.y + t * t * cv.p1.y,
    }
  }

  private newRunner(init: boolean): Runner {
    const cv = pick(this.curves), t = init ? rnd() : 0, p = this.qpt(cv, t)
    const k = rnd(); let mode: number, sp: number
    if (rnd() > this.C.runnerVariety) { mode = 1; sp = rr(0.12, 0.38) }
    else if (k < 0.3) { mode = 0; sp = rr(0.15, 0.28) }
    else if (k < 0.65) { mode = 1; sp = rr(0.1, 0.3) }
    else if (k < 0.8) { mode = 0; sp = rr(0.04, 0.08) }
    else if (k < 0.92) { mode = 0; sp = rr(0.5, 0.85) }
    else { mode = 2; sp = rr(0.06, 0.12) }
    return { cv, t, sp, mode, px: p.x, py: p.y, b: rnd() < 0.1 }
  }

  /* ---------------- 成组光束（comets） ---------------- */
  private spawnComet() {
    const lines: CometLine[] = []
    const n = Math.max(2, Math.round((8 + ((rnd() * 12) | 0)) * this.C.cometLines))
    if (rnd() < 0.6) {
      const rad = this.R * rr(0.55, 0.9), a0 = rr(-this.thV, this.thV) * 0.85
      const span = rr(0.35, 0.9) * (rnd() < 0.5 ? -1 : 1)
      const gap = rr(2.6, 4.4) * this.C.cometWidth
      for (let k = 0; k < n; k++) lines.push({ arc: true, r: rad - k * gap + gauss() * 0.6, a0: a0 + gauss() * 0.01, span })
    } else {
      const ang = rr(-this.thV, this.thV) * 0.8, oa = ang + rr(-1.3, 1.3), orad = this.R * rr(0.25, 0.75)
      const o = { x: Math.cos(oa) * orad, y: Math.sin(oa) * orad }
      const spread = rr(0.08, 0.25) * this.C.cometWidth, bend = rr(0.2, 0.5) * (rnd() < 0.5 ? -1 : 1)
      for (let i = 0; i < n; i++) {
        const ta = ang + (i / n - 0.5) * spread
        const p1 = { x: Math.cos(ta) * (this.R - 2), y: Math.sin(ta) * (this.R - 2) }
        const p0 = { x: o.x + gauss() * 10, y: o.y + gauss() * 10 }
        const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2
        const dx = p1.x - p0.x, dy = p1.y - p0.y
        lines.push({ p0, c: { x: mx - dy * bend + gauss() * 8, y: my + dx * bend + gauss() * 8 }, p1 })
      }
    }
    this.comets.push({
      lines, life: 0, hit: false, rot0: this.ringRot, dur: rr(0.4, 0.85) / this.C.cometSpeed,
      win: rr(0.22, 0.4), glow: rnd() < 0.4, tint: rnd() < 0.15,
    })
  }

  /* 成组光束上的一点：弧线走同心圆，直线走贝塞尔 */
  private comPt(l: CometLine, t: number) {
    if (!l.arc) return this.qpt(l as Curve, t)
    const r = (l.r as number) + (this.R - 2 - (l.r as number)) * t * t
    const a = (l.a0 as number) + (l.span as number) * t
    return { x: Math.cos(a) * r, y: Math.sin(a) * r }
  }

  private strokeComet(ctx: CanvasRenderingContext2D, c: Comet, t0: number, t1: number, steps: number) {
    ctx.beginPath()
    for (const l of c.lines) {
      for (let s = 0; s <= steps; s++) {
        const p = this.comPt(l, t0 + (t1 - t0) * (s / steps))
        if (s) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y)
      }
    }
    ctx.stroke()
  }

  /* ---------------- 环外：五层伸缩光束 ---------------- */
  private makeProfile(n: number) {
    const prof: number[] = []
    let v = rr(0.45, 1), run = 0
    for (let k = 0; k < n; k++) {
      if (run-- <= 0) { v = clamp(v + gauss() * 0.4, 0.22, 1); run = 2 + ((rnd() * 5) | 0) }
      prof.push(clamp(v + gauss() * 0.07, 0.18, 1))
    }
    return prof
  }

  private makeStrandLayer(stepDeg: number, rotK: number, lumK: number, lw: number, lenK: number, solidK: number, cover: number, nMin: number, nMax: number, brightP: number, dyn = 'soft'): StrandLayer {
    const step = stepDeg * Math.PI / 180
    const nb = Math.floor(TAU / step)
    const ws: Strand[] = []
    const count = Math.round(nb * cover / ((nMin + nMax) / 2))
    for (let j = 0; j < count; j++) {
      const n = nMin + ((rnd() * (nMax - nMin)) | 0), bright = rnd() < brightP
      ws.push({
        i0: (rnd() * nb) | 0, n, base: rr(0.35, 1), len: rr(0.1, 0.5), kick: 0,
        ph: rnd() * TAU, ph2: rnd() * TAU, f1: rr(0.22, 0.6), f2: rr(0.8, 1.7),
        lum: bright ? rr(0.75, 1) : rr(0.16, 0.55), tint: rnd() < 0.5 ? 1 : 0,
        lwK: rnd() < 0.2 ? rr(1.35, 2.1) : rr(0.6, 1.15), lenS: rr(0.6, 1.25),
        prof: this.makeProfile(n), pf: Array.from({ length: n }, () => rr(1, 4)),
        pp: Array.from({ length: n }, () => rnd() * TAU),
        ds: Array.from({ length: n }, () => rnd()), dsp: rr(0.7, 1.8), flow: 0,
      })
    }
    return { step, rotK, lumK, lw, lenK, solidK, wedges: ws, off: rnd() * TAU, dyn }
  }

  private buildOuter() {
    const pal = this.pal
    this.strands = [
      this.makeStrandLayer(0.22, 0.45, 0.30, 0.55, 1.15, 0.9, 1.1, 20, 90, 0.2),
      this.makeStrandLayer(0.16, 0.75, 0.58, 0.8, 1.05, 0.7, 0.9, 14, 70, 0.28),
      this.makeStrandLayer(0.12, 1.0, 1.0, 1.0, 1.0, 0.5, 0.75, 12, 60, 0.32),
      this.makeStrandLayer(0.45, 1.0, 0.5, 1.8, 0.8, 0.6, 0.35, 4, 16, 0.3),
      this.makeStrandLayer(0.12, 1.0, 0.85, 1.0, 1.0, 0.5, 0.55, 14, 70, 0.32, 'bounce'),
    ]
    this.hazes = []; this.flares = []; this.GR = {}
    const mkG = (stops: [number, string][], r1: number) => {
      const g = this.S.createRadialGradient(this.cx, this.cy, this.RO, this.cx, this.cy, r1)
      stops.forEach((s) => g.addColorStop(s[0], s[1]))
      return g
    }
    const rc = (c: RGB, a: number) => pal.rgba(c, a)
    const RMAX = this.RMAX
    /* 官方三束主光的色：冷白 / 粉紫 / 灰青。
       我们换成：主光（带体内温的白）/ 蓝（结构）/ 青（事实）。
       —— 这三种正好是记忆星图里「事实/关联/当前」的三色，两页因此同源。 */
    this.GR.s0 = mkG([[0, rc(pal.white, 1)], [0.35, rc(pal.white, 0.8)], [1, rc(pal.lilac, 0.3)]], RMAX * 0.95)
    this.GR.s1 = mkG([[0, rc(pal.lilac, 1)], [0.3, rc(pal.lilac, 0.82)], [1, rc(pal.lilac, 0.3)]], RMAX * 0.95)
    this.GR.s2 = mkG([[0, rc(pal.cool, 1)], [0.3, rc(pal.cool, 0.8)], [1, rc(pal.cool, 0.3)]], RMAX * 0.95)
    this.GR.h0 = mkG([[0, rc(pal.lilac, 0.95)], [0.25, rc(pal.lilac, 0.7)], [0.7, rc(pal.lilac, 0.25)], [1, rc(pal.lilac, 0)]], RMAX)
    this.GR.h1 = mkG([[0, rc(pal.white, 1)], [0.2, rc(pal.white, 0.65)], [0.65, rc(pal.white, 0.2)], [1, rc(pal.white, 0)]], RMAX)
    this.GR.h2 = mkG([[0, rc(pal.cool, 0.9)], [0.25, rc(pal.cool, 0.6)], [0.7, rc(pal.cool, 0.2)], [1, rc(pal.cool, 0)]], RMAX)
    for (let i = 0; i < 14; i++) this.spawnHaze(true)
    this.initFlyers()
  }

  private spawnHaze(init: boolean) {
    const k = rnd()
    this.hazes.push({
      a: rr(-this.thS, this.thS) - this.ringRot, w: rnd() < 0.7 ? rr(0.015, 0.07) : rr(0.08, 0.18),
      len: rr(0.35, 1), cur: init ? rr(0.2, 0.8) : 0, age: init ? rr(0, 0.5) : 0,
      life: rr(0.35, 1.6), alpha: rr(0.12, 0.42), tint: k < 0.55 ? 0 : k < 0.85 ? 1 : 2, drift: rr(-0.04, 0.04),
    })
  }

  private spawnFlare(a?: number | null) {
    this.flares.push({
      a: a == null ? rr(-this.thS, this.thS) * 0.95 - this.ringRot : a,
      w: rr(0.006, 0.04), len: rr(18, 110), age: 0, life: rr(0.2, 0.55), alpha: rr(0.6, 1),
    })
  }

  private buildLanes() {
    this.laneC = mk(this.W, this.H, this.DPR)
    const x = this.laneC.x
    for (let i = 0; i < 700; i++) {
      const a = rr(-this.thS, this.thS)
      x.strokeStyle = this.pal.rgba(this.pal.lilac, rr(0.01, 0.035))
      x.lineWidth = rr(0.5, 1)
      const r0 = this.RO + 4, r1 = rr(this.RO + 60, this.RMAX * 0.8)
      x.beginPath()
      x.moveTo(this.cx + Math.cos(a) * r0, this.cy + Math.sin(a) * r0)
      x.lineTo(this.cx + Math.cos(a) * r1, this.cy + Math.sin(a) * r1)
      x.stroke()
    }
  }

  private newFlyBand() { return { a: rr(-this.thS, this.thS), w: rr(0.01, 0.05), life: rr(2, 6) } }

  private newFlyer(init: boolean): Flyer {
    let a: number
    if (rnd() < 0.5) { const b = pick(this.flyBands); a = b.a + gauss() * b.w } else a = rr(-this.thS, this.thS)
    return {
      a: a - this.ringRot, len: 20 + Math.pow(rnd(), 2) * 320,
      r: init ? rr(this.RO, this.RMAX) : this.RO + rr(0, 25),
      sp: rr(260, 900), lw: rnd() < 0.08 ? rr(1.2, 1.7) : rr(0.5, 1),
      lv: rnd() < 0.12 ? 1 : 0, tint: rnd() < 0.22 ? 1 : 0, burst: false,
    }
  }

  private spawnFlyBurst() {
    const a = rr(-this.thS, this.thS) * 0.95
    const n = Math.max(1, Math.round((14 + ((rnd() * 30) | 0)) * this.C.burstSize))
    const spread = rr(0.01, 0.045)
    const sp = rr(450, 1150), len = rr(70, 320), r0 = this.RO + rr(0, 8)
    const tint = rnd() < 0.3 ? 1 : 0, lv = rnd() < 0.45 ? 2 : 1
    for (let i = 0; i < n; i++) {
      this.flyers.push({
        a: a + (i / n - 0.5) * spread + gauss() * 0.0015 - this.ringRot,
        len: len * rr(0.7, 1.15), r: r0 - rr(0, len * 0.35),
        sp: sp * rr(0.92, 1.08), lw: rnd() < 0.2 ? 1.3 : rr(0.6, 1), lv, tint, burst: true,
      })
    }
  }

  private initFlyers() {
    this.flyBands = Array.from({ length: 7 }, () => this.newFlyBand())
    const n = Math.round(Math.min(750, 320 + this.W * 0.25) * this.C.flyerCount)
    this.flyers = Array.from({ length: n }, () => this.newFlyer(true))
  }

  /* ---------------- 圆环数据块 ---------------- */
  private rimW() { return Math.max(3, (this.RO - this.R) * 0.065 * this.C.rimWidth) }

  private buildCards() {
    this.cards = []
    const band = this.RO - this.R
    const mid = this.R + band * 0.42
    let a = 0
    while (a < TAU - 0.03) {
      const hpx = rr(16, 62), da = hpx / mid, gap = rr(3, 9) / mid
      this.cards.push({ a: a + da / 2, da, hpx, c: null, flash: 0 })
      a += da + gap
    }
    Object.assign(this.rot, { from: 0, to: 0, t: 1, dur: 1, hold: 0 })
  }

  /* 官方那 12 种数据块（code / kv / spark / bars / prog / grid / gauge / wave /
     para / cols / barcode / matrix）—— 它们画的都是「格式」，不是内容。
     我们换掉里面的词：论文 → 讲次，方法 → 知识点，CFL → 正确率。 */
  private readonly HEAD = ['考点/03', '讲次', '真题 07', '知识点', '自测', '错因', '笔记 37', '词群 09', '缓冲 A',
    '错题场', '第 1284 步', '网格 64x64', '投影', '对流', '边界/墙', 'LBM D2Q9', '队列', '轨迹', '式(4)', '图 3', '校验', '场景 12']
  private readonly KEYS = ['dt', '进度', '数', '正确率', '容差', '轮', 'L2', '掌握', '偏差', '上限', '权重', '误差', '网格', '种子']
  private readonly CODE_T = ['load()', 'step(u)', 'proj(p)', 'bc.apply', 'solve()', 'grad p', 'div u', 'assert', 'f_eq', 'stream', 'collide', 'ok', 'PASS',
    'ref#12', 'diff', 'L2<tol', 'u*', '->', '==', 'dt/2', 'emit', 'push', 'read', 'fig3', 'eq4']

  private tintOf(i: number): RGB {
    // 官方十种 tint（六白 + 两紫 + 一青 + 一黄绿）→ 我们的十种（白/蓝/青/金）
    const pals = this.pal
    /* 官方十种里只有一个浅黄绿、而且很少出。我们把金色降一半亮度，
       否则在纯黑底上它比主光还抢眼 —— 环是背景，不是主角。 */
    const gold = [Math.round(pals.gold[0] * 0.62), Math.round(pals.gold[1] * 0.62), Math.round(pals.gold[2] * 0.62)] as RGB
    const T = [pals.white, pals.white, pals.white, pals.white, pals.white, pals.white,
      pals.lilac, pals.lilac, pals.cool, gold]
    return T[i] || pals.white
  }

  private fmtNum() {
    /* 有真实数就轮着用真实数 —— 环上的字不再是凭空编的。
       轮着用而不是总取第一个：一块数据格里要填好几个数，
       全填同一个会看起来像卡住了。 */
    if (this.factKeys.length) {
      const k = this.factKeys[this.factIx % this.factKeys.length]
      this.factIx++
      const v = this.facts[k]
      return typeof v === 'number' && Number.isFinite(v) ? String(v) : this._rndNum()
    }
    return this._rndNum()
  }

  private _rndNum() {
    const k = rnd()
    return k < 0.3 ? rr(0, 1).toFixed(3)
      : k < 0.55 ? (rr(1, 9).toFixed(1) + 'e-' + (2 + ((rnd() * 5) | 0)))
        : k < 0.8 ? String((rnd() * 9999) | 0) : rr(0, 100).toFixed(1)
  }

  private glyphs(ctx: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, pitch: number,
    opt: { tint: RGB; ragged?: boolean; colGap?: boolean; solid?: boolean; th: number }) {
    const tint = opt.tint
    for (let lx = x0; lx < x1 - 1; lx += pitch) {
      if (opt.colGap && rnd() < 0.18) { lx += pitch * 0.8; continue }
      const len = (y1 - y0) * (opt.ragged ? rr(0.35, 1) : rr(0.85, 1))
      const start = opt.ragged && rnd() < 0.3 ? y0 + rr(0, (y1 - y0) * 0.3) : y0
      let y = start
      const lb = rr(0.55, 1)
      while (y < Math.min(y1, start + len)) {
        const cl = opt.solid ? rr(2, 6) : rr(0.9, 2.2)
        if (rnd() < 0.9) { ctx.fillStyle = this.pal.rgba(tint, lb * rr(0.6, 1)); ctx.fillRect(lx, y, opt.th, Math.min(cl, y1 - y)) }
        y += cl + (rnd() < 0.12 ? rr(1.5, 3) : rr(0.5, 0.9))
      }
    }
  }

  private header(c: CanvasRenderingContext2D, x0: number, x1: number, y: number, t: RGB) {
    c.font = '700 4.3px ' + FONT
    c.fillStyle = this.pal.rgba(t, 0.95); c.fillText(pick(this.HEAD), x0, y)
    /* 右上角那个两位编号：有真实 key 就显示 key 缩写，没有才用随机数 */
    const tag = this.factKeys.length
      ? this.factKeys[(this.factIx - 1 + this.factKeys.length) % this.factKeys.length].slice(0, 2).toUpperCase()
      : String((rnd() * 99) | 0).padStart(2, '0')
    c.fillStyle = this.pal.rgba(t, 0.55); c.fillText(tag, x1 - 6, y)
    c.fillStyle = this.pal.rgba(t, 0.3); c.fillRect(x0, y + 5.6, x1 - x0, 0.45)
    return y + 7.5
  }

  private blockOf(name: string, c: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, t: RGB) {
    const P = this.pal
    const gaussr = gauss
    switch (name) {
      case 'code': {
        let y = this.header(c, x0, x1, y0, t)
        c.font = '500 3.5px ' + FONT
        let n = 1 + ((rnd() * 40) | 0)
        while (y < y1 - 3.5) {
          c.fillStyle = P.rgba(t, 0.3); c.fillText(String(n++).padStart(3, '0'), x0, y)
          let xx = x0 + 9
          const words = 1 + ((rnd() * 4) | 0)
          for (let i = 0; i < words && xx < x1 - 4; i++) {
            const w = pick(this.CODE_T)
            c.fillStyle = P.rgba(t, rnd() < 0.25 ? 1 : rr(0.5, 0.8))
            c.fillText(w, xx, y); xx += w.length * 2.15 + 2
          }
          y += 4.6
        }
        break
      }
      case 'kv': {
        let y = y1 - y0 > 18 ? this.header(c, x0, x1, y0, t) : y0 + 1
        c.font = '500 3.6px ' + FONT
        while (y < y1 - 4) {
          c.fillStyle = P.rgba(t, 0.5); c.fillText(pick(this.KEYS), x0, y)
          const v = this.fmtNum()
          c.fillStyle = P.rgba(t, 0.95); c.textAlign = 'right'; c.fillText(v, x1, y); c.textAlign = 'left'
          const bx = x0 + 14, bw = Math.max(0, x1 - x0 - 14 - v.length * 2.2 - 4)
          c.fillStyle = P.rgba(t, 0.15); c.fillRect(bx, y + 1.2, bw, 1.2)
          c.fillStyle = P.rgba(t, 0.7); c.fillRect(bx, y + 1.2, bw * rnd(), 1.2)
          y += 5.2
        }
        break
      }
      case 'spark': {
        const y = this.header(c, x0, x1, y0, t), top = y + 1, bot = y1 - 2, n = 40
        c.fillStyle = P.rgba(t, 0.18); c.fillRect(x0, bot, x1 - x0, 0.4); c.fillRect(x0, (top + bot) / 2, x1 - x0, 0.25)
        c.strokeStyle = P.rgba(t, 0.95); c.lineWidth = 0.55; c.beginPath()
        let v = rnd(), lx = 0, ly = 0
        for (let i = 0; i <= n; i++) {
          v = clamp(v + gaussr() * 0.22, 0, 1)
          lx = x0 + (x1 - x0) * i / n; ly = bot - v * (bot - top)
          if (i) c.lineTo(lx, ly); else c.moveTo(lx, ly)
        }
        c.stroke(); c.fillStyle = '#fff'; c.fillRect(lx - 0.9, ly - 0.9, 1.8, 1.8)
        break
      }
      case 'bars': {
        const y = this.header(c, x0, x1, y0, t), n = 6 + ((rnd() * 10) | 0), bh = (y1 - y - 1) / n
        c.font = '500 3px ' + FONT
        for (let i = 0; i < n; i++) {
          const v = rr(0.1, 1), yy = y + i * bh
          c.fillStyle = P.rgba(t, 0.35); c.fillText(String(i).padStart(2, '0'), x0, yy)
          c.fillStyle = P.rgba(t, v > 0.85 ? 1 : 0.65); c.fillRect(x0 + 7, yy + 0.4, (x1 - x0 - 7) * v, Math.max(0.8, bh - 1.2))
        }
        break
      }
      case 'prog': {
        let y = y1 - y0 > 18 ? this.header(c, x0, x1, y0, t) : y0 + 1
        c.font = '500 3.4px ' + FONT
        while (y < y1 - 5) {
          const p = rnd()
          c.fillStyle = P.rgba(t, 0.55); c.fillText(pick(['读', '做', '复', '测', '同步', '差分']), x0, y)
          c.fillStyle = P.rgba(t, 0.9); c.textAlign = 'right'; c.fillText(((p * 100) | 0) + '%', x1, y); c.textAlign = 'left'
          const bx = x0 + 15, bw = x1 - x0 - 26, segs = 12
          for (let i = 0; i < segs; i++) { c.fillStyle = P.rgba(t, i / segs < p ? 0.85 : 0.14); c.fillRect(bx + i * bw / segs, y + 0.6, bw / segs - 0.6, 2) }
          y += 5.4
        }
        break
      }
      case 'grid': {
        const y = y1 - y0 > 20 ? this.header(c, x0, x1, y0, t) : y0 + 1, p = rr(2.4, 3.2)
        for (let yy = y; yy < y1 - p + 0.5; yy += p) {
          for (let xx = x0; xx < x1 - p + 0.5; xx += p) {
            const v = rnd()
            c.fillStyle = v > 0.93 ? P.rgba(P.warm, 0.95) : P.rgba(t, 0.08 + v * v * 0.8)
            c.fillRect(xx, yy, p - 0.6, p - 0.6)
          }
        }
        break
      }
      case 'gauge': {
        const r = Math.min((y1 - y0) / 2 - 1.5, 9), gx = x0 + r + 1, gy = (y0 + y1) / 2, v = rnd()
        c.lineWidth = 1.2; c.strokeStyle = P.rgba(t, 0.15); c.beginPath(); c.arc(gx, gy, r, 0, TAU); c.stroke()
        c.strokeStyle = P.rgba(t, 0.95); c.beginPath(); c.arc(gx, gy, r, -Math.PI / 2, -Math.PI / 2 + TAU * v); c.stroke()
        c.font = '700 ' + Math.max(3.2, r * 0.55) + 'px ' + FONT
        c.textAlign = 'center'; c.textBaseline = 'middle'
        c.fillStyle = P.rgba(t, 1); c.fillText(String((v * 100) | 0), gx, gy)
        c.textAlign = 'left'; c.textBaseline = 'top'
        if (x1 - (gx + r) > 20) this.blockOf('kv', c, gx + r + 4, x1, y0, y1, t)
        break
      }
      case 'wave': {
        const y = this.header(c, x0, x1, y0, t), mid = (y + y1) / 2
        const amp = (y1 - y) * 0.38, f1 = rr(0.15, 0.4), f2 = rr(0.5, 1.2), ph = rnd() * 6
        const waves: [number, number][] = [[0.95, 1], [0.4, -0.6]]
        for (const [a, k] of waves) {
          c.strokeStyle = P.rgba(t, a); c.lineWidth = 0.5; c.beginPath()
          for (let xx = x0; xx <= x1; xx += 0.8) {
            const yy = mid + amp * k * (Math.sin(xx * f1 + ph) * 0.7 + Math.sin(xx * f2) * 0.3)
            if (xx === x0) c.moveTo(xx, yy); else c.lineTo(xx, yy)
          }
          c.stroke()
        }
        break
      }
      case 'para': this.glyphs(c, x0, x1, y0, y1, rr(2.6, 3.4), { tint: t, ragged: true, th: 1.3 }); break
      case 'cols': this.glyphs(c, x0, x1, y0, y1, rr(3.6, 4.6), { tint: t, colGap: true, th: 1.5 }); break
      case 'barcode': this.glyphs(c, x0, x1, y0, y1, rr(3.2, 4.2), { tint: t, solid: true, th: 1.8 }); break
      case 'matrix': {
        const p = rr(2.1, 2.6), dens = rr(0.35, 0.65)
        for (let yy = y0; yy < y1 - 1; yy += p) {
          for (let xx = x0; xx < x1; xx += p) {
            if (rnd() < dens) { c.fillStyle = P.rgba(t, rr(0.5, 1)); c.fillRect(xx, yy, 1.4, 1.4) }
          }
        }
        break
      }
    }
  }

  private pickBlock(h: number): string {
    const W: [string, number][] = [['code', 16], ['kv', 11], ['spark', 9], ['bars', 8], ['prog', 7], ['grid', 7], ['gauge', 3], ['wave', 4],
      ['para', 12], ['cols', 7], ['barcode', 6], ['matrix', 8]]
    const NEEDS: Record<string, number> = { code: 18, spark: 18, bars: 20, wave: 18, gauge: 16 }
    for (let tries = 0; tries < 8; tries++) {
      let r = rnd() * 100, name = 'para'
      for (const [n, w] of W) { r -= w; if (r <= 0) { name = n; break } }
      if (!NEEDS[name] || h >= NEEDS[name]) return name
    }
    return pick(['para', 'kv', 'matrix', 'barcode'])
  }

  private renderSlot(s: Slot) {
    const band = this.RO - this.R, h = s.hpx
    const RING_SC = 2.4
    const c = document.createElement('canvas') as Cv
    c.width = Math.ceil(band * RING_SC); c.height = Math.ceil((h + 2) * RING_SC)
    const x = c.getContext('2d') as CanvasRenderingContext2D
    x.scale(RING_SC, RING_SC); x.textBaseline = 'top'
    const RB = this.rimW(), dz0 = RB + 6, dz1 = band * 0.72, oz0 = band * 0.78, oz1 = band - RB - 5
    const split = rnd() < 0.45 && dz1 - dz0 > 60
    const blocks: [number, number][] = []
    if (split) { const m = dz0 + (dz1 - dz0) * rr(0.42, 0.6); blocks.push([dz0, m], [m + rr(4, 8), dz1]) }
    else blocks.push([dz0, dz1 - rr(0, 18)])
    for (const [b0, b1] of blocks) {
      const tint = this.tintOf((rnd() * 10) | 0), y0 = 1 + rr(0, 2), y1 = h + 1 - rr(0, 2)
      x.save(); x.beginPath(); x.rect(b0, y0 - 0.5, b1 - b0, y1 - y0 + 1); x.clip()
      this.blockOf(this.pickBlock(y1 - y0), x, b0, b1, y0, y1, tint)
      x.restore()
    }
    const pitch = rr(8, 12)
    x.font = '600 3.1px ' + FONT
    for (let yy = rr(1, pitch); yy < h - 2; yy += pitch) {
      if (rnd() < 0.15) continue
      let xx = oz0 + rr(0, 3)
      if (rnd() < 0.45) {
        x.fillStyle = this.pal.rgba(this.pal.white, rr(0.55, 0.95))
        x.fillText(String((rnd() * 999) | 0).padStart(3, '0'), xx, yy - 1); xx += 9
      }
      const n = 1 + ((rnd() * 3) | 0)
      for (let i = 0; i < n && xx < oz1; i++) {
        x.fillStyle = this.pal.rgba(this.pal.white, rr(0.5, 0.95))
        x.fillRect(xx, yy, rr(1.2, 2.4), 1.2); xx += rr(2.4, 3.6)
      }
    }
    if (rnd() < 0.45) {
      x.fillStyle = this.pal.rgba(this.pal.white, 0.7)
      for (let xx = dz0; xx < oz1; xx += rr(2.4, 4.5)) if (rnd() < 0.8) x.fillRect(xx, h + 0.4, 1.1, 1.1)
    }
    s.c = c
  }

  /* ---------------- 主循环 ---------------- */
  private frame(dt: number) {
    this.updateBeat(dt)
    this.updateCam(dt)
    this.updateOuter(dt)
    if (rnd() < dt * this.C.cometTrickle) this.spawnComet()
    this.webRot += dt * (0.03 + this.env * 0.12) * this.C.webSpin
    this.updateRing(dt)
    for (let k = 0; k < 3; k++) this.layerEnv[k] *= Math.exp(-dt * 2.2)

    const S = this.S
    S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    S.globalCompositeOperation = 'source-over'
    S.globalAlpha = 1
    S.fillStyle = this.pal.bg
    S.fillRect(0, 0, this.W, this.H)

    const G = this.glowC.x
    G.setTransform(1, 0, 0, 1, 0, 0)
    G.clearRect(0, 0, this.glowC.width, this.glowC.height)
    this.camT(G, 1 / this.GS)
    G.globalCompositeOperation = 'lighter'

    this.camTk(S, this.DPR, 1 - 0.1 * this.C.parallax)

    /* 圈内：静态网 + 三层呼吸光 */
    S.save(); S.translate(this.cx, this.cy); S.rotate(this.webRot)
    const ws = 2 * this.R + 4
    S.drawImage(this.webBase, -this.R - 2, -this.R - 2, ws, ws)
    S.globalCompositeOperation = 'lighter'
    this.webLayers.forEach((c, k) => {
      S.globalAlpha = Math.min(1, this.C.webPulseBase + this.C.webPulseAmp * this.layerEnv[k])
      S.drawImage(c, -this.R - 2, -this.R - 2, ws, ws)
    })
    S.globalAlpha = 1

    /* 跑步光线：存档画布做 destination-out 淡出，越接近节拍越亮 */
    const tx = this.trailC.x, surge = 0.5 + 2.5 * this.env
    while (this.runners.length < this.C.runnerCount) this.runners.push(this.newRunner(true))
    if (this.runners.length > this.C.runnerCount) this.runners.length = Math.max(0, Math.round(this.C.runnerCount))
    tx.globalCompositeOperation = 'destination-out'
    tx.fillStyle = 'rgba(0,0,0,' + (0.05 + this.env * 0.05) + ')'
    tx.fillRect(0, 0, ws, ws)
    tx.globalCompositeOperation = 'source-over'
    tx.save(); tx.translate(this.R + 2, this.R + 2); tx.lineCap = 'round'
    for (let i = 0; i < this.runners.length; i++) {
      const r = this.runners[i]
      r.t += dt * this.C.runnerSpeed * (r.mode === 1 ? r.sp * surge : r.mode === 2 ? r.sp + 1.3 * r.t * r.t : r.sp)
      if (r.t >= 1) { this.runners[i] = this.newRunner(false); continue }
      const p = this.qpt(r.cv, r.t)
      tx.strokeStyle = r.b ? this.pal.rgba(this.pal.warm, Math.min(1, 0.9 * this.C.runnerBright))
        : this.pal.rgba(this.pal.white, Math.min(1, 0.75 * this.C.runnerBright))
      tx.lineWidth = (r.b ? 1.3 : 0.9) * this.C.runnerWidth
      tx.beginPath(); tx.moveTo(r.px, r.py); tx.lineTo(p.x, p.y); tx.stroke()
      r.px = p.x; r.py = p.y
    }
    tx.restore()
    S.drawImage(this.trailC, -this.R - 2, -this.R - 2, ws, ws)
    S.restore()
    this.camT(S, this.DPR)

    /* 圆环遮挡阴影：把圈内在靠近环处压暗，两个平面才分得开 */
    if (this.C.ringShadow > 0) {
      const sg = S.createRadialGradient(this.cx, this.cy, this.R - 110, this.cx, this.cy, this.R)
      sg.addColorStop(0, 'rgba(0,0,0,0)')
      sg.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, 0.8 * this.C.ringShadow) + ')')
      S.globalCompositeOperation = 'source-over'; S.globalAlpha = 1; S.fillStyle = sg
      S.beginPath(); S.arc(this.cx, this.cy, this.R, 0, TAU); S.arc(this.cx, this.cy, this.R - 110, 0, TAU, true)
      S.fill('evenodd')
    }

    /* 成组光束 */
    S.save(); S.translate(this.cx, this.cy); S.globalCompositeOperation = 'lighter'; S.lineCap = 'round'
    G.save(); G.translate(this.cx, this.cy)
    for (let i = this.comets.length - 1; i >= 0; i--) {
      const c = this.comets[i]
      c.life += dt
      const p = easeIO(Math.min(1, c.life / c.dur))
      const head = Math.min(1, p * (1 + c.win)), tail = Math.max(0, p * (1 + c.win) - c.win)
      const fade = c.life > c.dur ? Math.max(0, 1 - (c.life - c.dur) / 0.25) : 1
      if (fade <= 0) { this.comets.splice(i, 1); continue }
      const cr = this.C.cometFollow ? this.ringRot - c.rot0 : 0
      if (head >= 1 && !c.hit) {
        c.hit = true
        const pe = this.comPt(c.lines[c.lines.length >> 1], 1)
        this.flashSlotAt(Math.atan2(pe.y, pe.x) + cr)
      }
      S.save(); S.rotate(cr); G.save(); G.rotate(cr)
      const col: RGB = c.tint ? this.pal.lilac : this.pal.white
      S.strokeStyle = this.pal.rgba(col, Math.min(1, 0.5 * fade * this.C.cometBright)); S.lineWidth = 1
      this.strokeComet(S, c, tail, head, 18)
      const hs = head - (head - tail) * 0.35
      S.strokeStyle = this.pal.rgba(col, Math.min(1, fade * this.C.cometBright)); S.lineWidth = 1.7
      this.strokeComet(S, c, hs, head, 8)
      if (c.glow && this.C.cometGlow > 0) {
        G.strokeStyle = this.pal.rgba(col, Math.min(1, 0.5 * fade * this.C.cometGlow)); G.lineWidth = 2.8
        this.strokeComet(G, c, hs, head, 6)
      }
      G.restore(); S.restore()
    }
    G.restore(); S.restore()

    /* 环外 */
    S.globalCompositeOperation = 'lighter'
    S.drawImage(this.laneC, 0, 0, this.W, this.H)

    const F = this.farC.x
    F.setTransform(1, 0, 0, 1, 0, 0)
    F.globalAlpha = 1; F.globalCompositeOperation = 'source-over'
    F.clearRect(0, 0, this.farC.width, this.farC.height)
    this.camT(F, this.FS); F.globalCompositeOperation = 'lighter'
    const savedS = this.S
    this.S = F
    this.drawOuterFar()
    this.S = savedS
    S.save(); S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0); S.globalCompositeOperation = 'lighter'
    const hasFilter = typeof (S as any).filter === 'string'
    if (hasFilter && this.C.depthBlur > 0) S.filter = 'blur(' + this.C.depthBlur + 'px)'
    S.globalAlpha = Math.min(1, this.C.depthDim)
    S.drawImage(this.farC, 0, 0, this.W, this.H)
    S.restore()

    if (this.C.atmos > 0) {
      const ag = S.createRadialGradient(this.cx, this.cy, this.RO, this.cx, this.cy, this.RO + (this.RMAX - this.RO) * 0.7)
      ag.addColorStop(0, this.pal.rgba(this.pal.lilac, Math.min(1, 0.07 * this.C.atmos)))
      ag.addColorStop(0.4, this.pal.rgba(this.pal.lilac, Math.min(1, 0.028 * this.C.atmos)))
      ag.addColorStop(1, 'rgba(0,0,0,0)')
      S.globalAlpha = 1; S.fillStyle = ag
      S.beginPath(); S.arc(this.cx, this.cy, this.RMAX, 0, TAU); S.arc(this.cx, this.cy, this.RO, 0, TAU, true)
      S.fill('evenodd')
    }
    this.drawOuterNear()
    this.drawRing(dt)

    /* 记忆星图：叠在环与光束之间，是这一页的主角 */
    /* star 模式不在引擎里画记忆：记忆交给 memoryfield（另一种笔法）。
       引擎在 star 模式下只负责把光束压下去、把舞台让出来。 */

    /* 辉光合成 */
    S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    S.globalCompositeOperation = 'lighter'
    if (hasFilter) S.filter = 'blur(6px)'
    S.globalAlpha = Math.min(1, 0.9 * this.C.glow)
    S.drawImage(this.glowC, 0, 0, this.glowC.width * this.GS, this.glowC.height * this.GS)
    if (hasFilter) S.filter = 'none'
    S.globalAlpha = 1; S.globalCompositeOperation = 'source-over'

    this.drawBokeh(dt)
    if (this.C.vignette > 0) {
      S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
      const vg = S.createRadialGradient(this.W * 0.45, this.H * 0.5, Math.min(this.W, this.H) * 0.35,
        this.W * 0.45, this.H * 0.5, Math.hypot(this.W, this.H) * 0.62)
      vg.addColorStop(0, 'rgba(0,0,0,0)')
      vg.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, 0.75 * this.C.vignette) + ')')
      S.fillStyle = vg; S.fillRect(0, 0, this.W, this.H)
    }

    this.hooks.onFrame?.(dt, this.T)
    this.hooks.onCamera?.(this.cam)
  }

  /* ---------------- 节拍 ---------------- */
  private updateBeat(dt: number) {
    this.beatT -= dt; this.sinceBeat += dt
    const PATTERN = [0.5, 0.25, 0.25, 0.5, 0.5, 0.75, 0.25, 0.25, 0.25, 1.0]
    if (this.beatT <= 0) {
      this.beatT += PATTERN[this.beatI++ % PATTERN.length] * 0.92 / this.C.tempo
      this.sinceBeat = 0; this.beatN++
      this.onBeat()
    }
    this.env = Math.exp(-this.sinceBeat * 4.5)
  }

  private onBeat() {
    if (this.rot.t >= this.rot.dur && this.rot.hold <= 0) this.ringMove()
    const n = Math.round((this.beatN % 4 === 0 ? this.C.cometBurst : this.C.cometPerBeat) * rr(0.6, 1.4))
    for (let i = 0; i < n; i++) setTimeout(() => this.spawnComet(), i * rr(30, 90))
    this.layerEnv[(rnd() * 3) | 0] = 1
    if (this.beatN % 4 === 0) this.layerEnv = this.layerEnv.map(() => rr(0.6, 1))
    const dir = rnd() < 0.5 ? 1 : -1, big = this.beatN % 8 === 0
    this.pulses.push({
      c: dir > 0 ? -this.thS - 0.15 : this.thS + 0.15,
      v: dir * rr(0.7, 1.6) * (big ? 0.7 : 1),
      w: big ? rr(0.25, 0.4) : rr(0.05, 0.16),
      amp: big ? 1 : rr(0.45, 0.9), life: rr(1.2, 2.0), L: 0,
    })
    this.pulses.forEach((p) => { if (!p.L) p.L = p.life })
    this.onBeatOuter()
    for (let i = 0; i < Math.round(6 * this.C.dataFlicker); i++) pick(this.cards).c = null
    for (let i = 0; i < Math.round(2 * this.C.dataFlicker); i++) pick(this.cards).flash = rr(0.35, 0.7)
    this.hooks.onBeat?.(this.beatN)
  }

  /* ---------------- 运镜 ---------------- */
  private camT(ctx: CanvasRenderingContext2D, d: number) {
    const z = this.cam.z
    ctx.setTransform(d * z, 0, 0, d * z,
      d * (this.W / 2 - this.cam.x * z), d * (this.H / 2 - this.cam.y * z))
  }

  private camTk(ctx: CanvasRenderingContext2D, d: number, k: number) {
    const z = 1 + (this.cam.z - 1) * k
    const x = this.W / 2 + (this.cam.x - this.W / 2) * k
    const y = this.H / 2 + (this.cam.y - this.H / 2) * k
    ctx.setTransform(d * z, 0, 0, d * z, d * (this.W / 2 - x * z), d * (this.H / 2 - y * z))
  }

  private updateCam(dt: number) {
    if (!this.C.camera) { this.cam.x = this.W / 2; this.cam.y = this.H / 2; this.cam.z = 1; return }
    this.shotT += dt
    const cur = this.shots[this.shotI], nxt = this.shots[(this.shotI + 1) % this.shots.length]
    const zf = (z: number) => 1 + (z - 1) * this.C.camZoom
    if (this.camPhase === 'hold') {
      const k = this.shotT / cur.hold
      this.cam.x = cur.x
      this.cam.y = cur.y + (cur.z > 1 ? Math.sin(k * Math.PI) * 6 : 0)
      this.cam.z = zf(cur.z) * (1 + 0.05 * k * this.C.camZoom)
      if (this.shotT >= cur.hold) { this.camPhase = 'move'; this.shotT = 0; this.camFrom = { ...this.cam } }
    } else {
      const dur = 2.2, e = easeIO(Math.min(1, this.shotT / dur))
      const from = this.camFrom || this.cam
      const lz = Math.log(from.z) + (Math.log(zf(nxt.z)) - Math.log(from.z)) * e
      let z = Math.exp(lz)
      if (from.z > 1.2 && zf(nxt.z) > 1.2) z *= 1 - 0.4 * Math.sin(Math.PI * e)
      this.cam.z = Math.max(1, z)
      this.cam.x = from.x + (nxt.x - from.x) * e
      this.cam.y = from.y + (nxt.y - from.y) * e
      if (this.shotT >= dur) { this.shotI = (this.shotI + 1) % this.shots.length; this.camPhase = 'hold'; this.shotT = 0 }
    }
    const hw = this.W / (2 * this.cam.z), hh = this.H / (2 * this.cam.z)
    this.cam.x = Math.max(hw, Math.min(this.W - hw, this.cam.x))
    this.cam.y = Math.max(hh, Math.min(this.H - hh, this.cam.y))
  }

  /* ---------------- 环外更新 ---------------- */
  private updateOuter(dt: number) {
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]
      p.c += p.v * dt; p.life -= dt
      if (p.life <= 0) this.pulses.splice(i, 1)
    }
    for (const Lr of this.strands) {
      const rot = this.ringRot * Lr.rotK + Lr.off
      for (const w of Lr.wedges) {
        const am = normA((w.i0 + w.n / 2) * Lr.step + rot)
        w.vis = Math.abs(am) < this.thS + 0.2
        w.flow += dt * w.dsp * (0.45 + 2.2 * this.env)
        if (!w.vis) { w.len *= 0.98; continue }
        let p = 0
        for (const pl of this.pulses) {
          const f = Math.min(1, pl.life / 0.5) * Math.min(1, (pl.L - pl.life) / 0.15 + 0.3)
          p += pl.amp * f * Math.exp(-Math.pow((am - pl.c) / pl.w, 2))
        }
        if (Lr.dyn === 'bounce') {
          const idle = w.base * (0.36 + 0.14 * Math.sin(this.T * 0.9 + w.ph))
          const tgt = Math.min(1, idle + p * 0.75 + w.kick * 0.6)
          w.kick *= Math.exp(-dt * 2.4)
          w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 15 : 2.2) * dt)
        } else {
          const n1 = 0.5 + 0.5 * Math.sin(this.T * w.f1 + w.ph)
          const n2 = 0.5 + 0.5 * Math.sin(this.T * w.f2 + w.ph2)
          const idle = w.base * (0.4 + 0.34 * n1 + 0.14 * n2)
          const tgt = Math.min(1.05, (idle + p * 0.7 + w.kick * 0.55) * w.lenS)
          w.kick *= Math.exp(-dt * 1.8)
          w.len += (tgt - w.len) * Math.min(1, (tgt > w.len ? 5 : 1.3) * dt)
        }
      }
    }
    for (let i = this.hazes.length - 1; i >= 0; i--) {
      const h = this.hazes[i]; h.age += dt
      h.cur += (h.len - h.cur) * Math.min(1, 9 * dt)
      if (h.age > h.life + 0.6) this.hazes.splice(i, 1)
    }
    if (this.hazes.length < this.C.hazeCount && rnd() < 0.25) this.spawnHaze(false)
    for (let i = this.flares.length - 1; i >= 0; i--) {
      this.flares[i].age += dt
      if (this.flares[i].age > this.flares[i].life) this.flares.splice(i, 1)
    }
    if (rnd() < 0.06 * this.C.flareRate) this.spawnFlare()
    this.updateFlyers(dt)
  }

  private onBeatOuter() {
    this.onBeatFlyers()
    const wedges = this.strands[2].wedges.concat(this.strands[4].wedges)
    for (let i = 0; i < 2 + ((rnd() * 5) | 0); i++) {
      const w = pick(wedges)
      w.kick = rr(0.4, 1)
      if (rnd() < 0.5) w.prof = this.makeProfile(w.n)
    }
    for (let i = 0; i < 2; i++) {
      const w = pick(wedges)
      w.lum = rnd() < 0.4 ? rr(0.8, 1) : rr(0.25, 0.6)
    }
    const nh = this.beatN % 4 === 0 ? 5 + ((rnd() * 4) | 0) : 1 + ((rnd() * 3) | 0)
    for (let i = 0; i < Math.round(nh * this.C.hazeCount / 8); i++) this.spawnHaze(false)
    const nf = Math.round((1 + ((rnd() * 4) | 0)) * this.C.flareRate)
    for (let i = 0; i < nf; i++) this.spawnFlare(this.hazes.length && rnd() < 0.6 ? pick(this.hazes).a : null)
  }

  private hazeEnv(h: Haze) {
    const a = Math.min(1, h.age / 0.12)
    const o = h.age > h.life ? Math.max(0, 1 - (h.age - h.life) / 0.6) : 1
    return a * o * (0.85 + 0.15 * Math.sin(h.age * 30))
  }

  private radialLines(a0: number, a1: number, st: number, r0: number, L: number, seed: number, lo: number) {
    const S = this.S
    S.beginPath()
    let k = 0
    for (let a = a0; a < a1; a += st, k++) {
      const l = L * (lo + (1 - lo) * hash(k + seed))
      const ca = Math.cos(a), sa = Math.sin(a)
      S.moveTo(this.cx + ca * r0, this.cy + sa * r0)
      S.lineTo(this.cx + ca * (r0 + l), this.cy + sa * (r0 + l))
    }
  }

  private drawStrands(Lr: StrandLayer, collect: { dash: number[]; tip: number[] } | null) {
    const S = this.S
    const span = this.RMAX - this.RO - 20, r0 = this.RO + 3
    const rot = this.ringRot * Lr.rotK + Lr.off
    const EDGE_A = [0.28, 0.62, 1]
    S.lineCap = 'butt'
    for (const w of Lr.wedges) {
      if (!w.vis) continue
      const L = w.len * span * Lr.lenK * this.C.beamLen
      if (L < 3) continue
      const a0 = normA(w.i0 * Lr.step + rot), a1 = a0 + w.n * Lr.step
      if (a1 < -this.thS - 0.03 || a0 > this.thS + 0.03) continue
      const alpha = Math.min(1, w.lum * Lr.lumK * (0.3 + 0.7 * Math.min(1, w.len * 1.8)) * this.C.beamBright * (Lr.dyn === 'bounce' ? this.C.beamBounce : 1))
      if (alpha < 0.005) continue
      const lwW = Lr.lw * w.lwK * this.C.beamWidth
      const paths = [new Path2D(), new Path2D(), new Path2D()]
      for (let k = 0; k < w.n; k++) {
        const a = a0 + (k + 0.5) * Lr.step, ca = Math.cos(a), sa = Math.sin(a)
        const edge = Math.sin(Math.PI * (k + 0.5) / w.n)
        const b = edge < 0.38 ? 0 : edge < 0.72 ? 1 : 2
        const pr = w.prof[k]
        const l = L * pr * (0.5 + 0.5 * Math.sqrt(edge)) * (0.92 + 0.08 * Math.sin(this.T * w.pf[k] + w.pp[k]))
        const solid = l * (Lr.solidK + 0.3 * pr * (1 - Lr.solidK))
        paths[b].moveTo(this.cx + ca * r0, this.cy + sa * r0)
        paths[b].lineTo(this.cx + ca * (r0 + solid), this.cy + sa * (r0 + solid))
        if (!collect) continue
        const tail = l - solid, da = alpha * EDGE_A[b]
        if (tail > 6) {
          for (let d = 0; d < 2; d++) {
            const ph = (w.flow + w.ds[k] + d * 0.5) % 1
            const s0 = solid + tail * ph
            const s1 = Math.min(l, s0 + 3 + tail * 0.22 * (1 - ph * 0.5))
            if (s1 > s0) collect.dash.push(ca, sa, s0, s1, da)
          }
        }
        if ((k + ((this.T * 12) | 0)) % 4 === 0) collect.tip.push(ca, sa, l, da)
      }
      S.strokeStyle = this.GR['s' + w.tint]
      S.lineWidth = lwW
      for (let b = 0; b < 3; b++) { S.globalAlpha = alpha * EDGE_A[b]; S.stroke(paths[b]) }
      if (w.lum > 0.85 && this.C.beamGlow > 0) {
        S.globalAlpha = Math.min(1, alpha * 0.06 * this.C.beamGlow)
        S.lineWidth = lwW * 2.5
        S.stroke(paths[2])
      }
    }
  }

  private updateFlyers(dt: number) {
    for (const b of this.flyBands) { b.life -= dt; if (b.life <= 0) Object.assign(b, this.newFlyBand()) }
    const k = (0.7 + 0.9 * this.env) * this.C.flyerSpeed
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i]
      f.r += f.sp * dt * k
      if (f.r - f.len > this.RMAX) {
        if (f.burst) this.flyers.splice(i, 1)
        else this.flyers[i] = this.newFlyer(false)
      }
    }
  }

  private onBeatFlyers() {
    const n = Math.round((this.beatN % 4 === 0 ? 3 + ((rnd() * 2) | 0) : 1 + ((rnd() * 2) | 0)) * this.C.burstRate)
    for (let i = 0; i < n; i++) setTimeout(() => this.spawnFlyBurst(), i * rr(20, 120))
  }

  private drawFlyers(bursts: boolean) {
    const S = this.S
    const FLY_A = [0.16, 0.36, 0.7]
    const buckets: Record<string, number[]> = {}
    for (const f of this.flyers) {
      if (f.burst !== bursts) continue
      const a = normA(f.a + this.ringRot)
      if (a < -this.thS - 0.05 || a > this.thS + 0.05) continue
      const key = String(f.tint * 10 + f.lv + (f.lw > 1.15 ? 100 : 0) + (f.burst ? 1000 : 0))
      const arr = buckets[key] || (buckets[key] = [])
      arr.push(f as any, a)
    }
    for (const key in buckets) {
      const arr = buckets[key]
      const f0 = arr[0] as unknown as Flyer
      S.strokeStyle = f0.tint ? this.GR.s1 : this.GR.s0
      S.globalAlpha = Math.min(1, FLY_A[f0.lv] * (f0.burst ? this.C.burstBright : this.C.flyerBright))
      S.lineWidth = ((Number(key) % 1000) >= 100 ? 1.5 : 0.8) * this.C.flyerWidth
      S.beginPath()
      for (let i = 0; i < arr.length; i += 2) {
        const f = arr[i] as unknown as Flyer, a = arr[i + 1]
        const r0 = Math.max(this.RO + 3, f.r - f.len), r1 = f.r
        if (r1 <= r0) continue
        const ca = Math.cos(a), sa = Math.sin(a)
        S.moveTo(this.cx + ca * r0, this.cy + sa * r0)
        S.lineTo(this.cx + ca * r1, this.cy + sa * r1)
      }
      S.stroke()
    }
    S.globalAlpha = 1
  }

  private drawOuterFar() {
    const S = this.S
    const span = this.RMAX - this.RO - 20, r0 = this.RO + 3
    for (const h of this.hazes) {
      const e = this.hazeEnv(h)
      if (e <= 0.01) continue
      if (h.seed === undefined) h.seed = rnd() * 1000
      const L = h.cur * span
      this.radialLines(h.a + this.ringRot - h.w / 2, h.a + this.ringRot + h.w / 2, this.OSTEP * 0.55, r0, L, h.seed, 0.45)
      S.strokeStyle = this.GR['s' + (h.tint === 1 ? 0 : h.tint === 2 ? 2 : 1)]
      S.globalAlpha = Math.min(1, h.alpha * e * 0.05 * this.C.hazeBright); S.lineWidth = 2.2; S.stroke()
      S.globalAlpha = Math.min(1, h.alpha * e * 0.6 * this.C.hazeBright); S.lineWidth = 0.55; S.stroke()
    }
    this.drawStrands(this.strands[0], null)
    this.drawStrands(this.strands[1], null)
    this.drawFlyers(false)
    S.globalAlpha = 1
  }

  private drawOuterNear() {
    const S = this.S
    const r0 = this.RO + 3
    const col = { dash: [] as number[], tip: [] as number[] }
    this.drawStrands(this.strands[2], col)
    this.drawStrands(this.strands[4], col)
    this.drawStrands(this.strands[3], null)
    S.strokeStyle = this.pal.rgba(this.pal.white, 1)
    S.lineWidth = 1.05
    for (const lv of [0.35, 0.65, 1]) {
      S.globalAlpha = Math.min(1, lv * this.C.dashBright)
      S.beginPath()
      const dp = col.dash
      for (let i = 0; i < dp.length; i += 5) {
        const a = dp[i + 4]
        if (a > lv || a <= lv - 0.35) continue
        S.moveTo(this.cx + dp[i] * (r0 + dp[i + 2]), this.cy + dp[i + 1] * (r0 + dp[i + 2]))
        S.lineTo(this.cx + dp[i] * (r0 + dp[i + 3]), this.cy + dp[i + 1] * (r0 + dp[i + 3]))
      }
      S.stroke()
    }
    S.fillStyle = this.pal.rgba(this.pal.white, 1)
    for (let i = 0; i < col.tip.length; i += 4) {
      S.globalAlpha = Math.min(1, col.tip[i + 3] * 1.2)
      const r = r0 + col.tip[i + 2]
      S.fillRect(this.cx + col.tip[i] * r - 0.8, this.cy + col.tip[i + 1] * r - 0.8, 1.6, 1.6)
    }
    this.drawFlyers(true)
    S.strokeStyle = this.GR.s0
    for (const f of this.flares) {
      if (f.seed === undefined) f.seed = rnd() * 1000
      const t = f.age / f.life
      const e = (t < 0.15 ? t / 0.15 : Math.pow(1 - (t - 0.15) / 0.85, 2)) * f.alpha
      const L = f.len * (0.6 + 0.4 * easeO(Math.min(1, t * 3)))
      this.radialLines(f.a + this.ringRot - f.w / 2, f.a + this.ringRot + f.w / 2, this.OSTEP * 0.45, r0, L, f.seed, 0.4)
      S.globalAlpha = Math.min(1, e * 0.06 * this.C.flareBright); S.lineWidth = 2.6; S.stroke()
      S.globalAlpha = Math.min(1, e * this.C.flareBright); S.lineWidth = 0.8; S.stroke()
    }
    S.globalAlpha = 1
  }

  private mkBokehSprite() {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const x = c.getContext('2d') as CanvasRenderingContext2D
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,255,.9)')
    g.addColorStop(0.5, this.pal.rgba(this.pal.white, 0.5))
    g.addColorStop(0.82, this.pal.rgba(this.pal.lilac, 0.22))
    g.addColorStop(0.93, this.pal.rgba(this.pal.lilac, 0.32))
    g.addColorStop(1, this.pal.rgba(this.pal.lilac, 0))
    x.fillStyle = g; x.fillRect(0, 0, 128, 128)
    return c
  }

  private newBokeh(): Bokeh {
    const big = rnd() < 0.3
    return {
      x: rr(-0.1, 1.1) * this.W, y: rr(-0.1, 1.1) * this.H,
      r: big ? rr(24, 64) : rr(5, 22), a: big ? rr(0.025, 0.07) : rr(0.05, 0.16),
      vx: rr(-10, 10), vy: rr(-6, 6), st: rnd() < 0.3 ? rr(2, 5) : 1, ph: rnd() * TAU,
    }
  }

  private drawBokeh(dt: number) {
    const S = this.S
    const n = Math.round(this.C.bokeh)
    while (this.bokehs.length < n) this.bokehs.push(this.newBokeh())
    if (this.bokehs.length > n) this.bokehs.length = n
    if (!n) return
    if (!this.bokehSpr) this.bokehSpr = this.mkBokehSprite()
    const k = 1 + 0.6 * this.C.parallax
    const z = 1 + (this.cam.z - 1) * k
    const ox = (this.cam.x - this.W / 2) * k, oy = (this.cam.y - this.H / 2) * k
    S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    S.globalCompositeOperation = 'lighter'
    for (const b of this.bokehs) {
      b.x += b.vx * dt; b.y += b.vy * dt
      if (b.x < -0.15 * this.W) b.x += 1.3 * this.W
      if (b.x > 1.15 * this.W) b.x -= 1.3 * this.W
      if (b.y < -0.15 * this.H) b.y += 1.3 * this.H
      if (b.y > 1.15 * this.H) b.y -= 1.3 * this.H
      const sx = (b.x - this.W / 2 - ox) * z + this.W / 2
      const sy = (b.y - this.H / 2 - oy) * z + this.H / 2
      const r = b.r * z
      S.globalAlpha = Math.min(1, b.a * this.C.bokehBright * (0.75 + 0.25 * Math.sin(this.T * 0.8 + b.ph)) * (1 + this.env * 0.3))
      S.drawImage(this.bokehSpr, sx - r * b.st, sy - r, 2 * r * b.st, 2 * r)
    }
    S.globalAlpha = 1
    S.globalCompositeOperation = 'source-over'
  }

  private ringMove() {
    const r = rnd()
    let d: number, dur: number, ease: (t: number) => number
    if (r < 0.22) { d = rr(1.1, 2.1); dur = rr(0.7, 1.05); ease = easeIO }
    else if (r < 0.64) { d = rr(0.14, 0.48); dur = rr(0.18, 0.38); ease = easeOX }
    else { d = rr(0.05, 0.18); dur = rr(0.3, 0.6); ease = easeIO }
    if (rnd() < 0.08) d = -d * 0.5
    d *= this.C.ringSpeed
    Object.assign(this.rot, { from: this.ringRot, to: this.ringRot + d, t: 0, dur, ease, hold: rr(0.04, 0.4) * this.C.ringPause })
  }

  private flashSlotAt(ang: number) {
    let best: Slot | null = null, bd = 9
    for (const s of this.cards) {
      const d = Math.abs(normA(s.a + this.ringRot - ang))
      if (d < bd) { bd = d; best = s }
    }
    if (best && bd < 0.08) best.flash = Math.max(best.flash, 0.8)
  }

  private updateRing(dt: number) {
    if (this.rot.t < this.rot.dur) {
      this.rot.t += dt
      this.ringRot = this.rot.from + (this.rot.to - this.rot.from) * this.rot.ease(Math.min(1, this.rot.t / this.rot.dur))
    } else {
      this.rot.hold -= dt
      this.ringRot += 0.02 * dt
    }
  }

  private drawRing(dt: number) {
    const S = this.S
    const band = this.RO - this.R
    S.globalCompositeOperation = 'source-over'
    S.save(); S.translate(this.cx, this.cy)
    S.beginPath(); S.arc(0, 0, this.RO, 0, TAU); S.arc(0, 0, this.R, 0, TAU, true)
    S.fillStyle = this.pal.band; S.fill('evenodd')
    let regen = 1
    for (const s of this.cards) {
      const A = s.a + this.ringRot
      if (s.flash > 0) s.flash = Math.max(0, s.flash - dt * 2.2)
      const mid = this.R + band * 0.42
      const sp = { x: (this.cx + Math.cos(A) * mid - this.cam.x) * this.cam.z + this.W / 2, y: (this.cy + Math.sin(A) * mid - this.cam.y) * this.cam.z + this.H / 2 }
      if (sp.x < -140 || sp.x > this.W + 140 || sp.y < -140 || sp.y > this.H + 140) continue
      if (!s.c || (regen > 0 && rnd() < 0.02)) { this.renderSlot(s); regen-- }
      if (!s.c) continue
      S.save(); S.rotate(A)
      const hh = s.hpx + 2
      S.drawImage(s.c, this.R, -hh / 2, band, hh)
      if (s.flash > 0.02) {
        S.globalCompositeOperation = 'lighter'
        S.globalAlpha = s.flash
        S.drawImage(s.c, this.R, -hh / 2, band, hh)
        S.globalAlpha = 1
        S.globalCompositeOperation = 'source-over'
      }
      S.restore()
    }
    const tick = (step: number, fn: (ca: number, sa: number, n: number) => void) => {
      const n0 = Math.floor((-this.thV - 0.05 - this.ringRot) / step)
      const n1 = Math.ceil((this.thV + 0.05 - this.ringRot) / step)
      for (let n = n0; n <= n1; n++) {
        const a = n * step + this.ringRot
        fn(Math.cos(a), Math.sin(a), n)
      }
    }
    const RB = this.rimW()
    S.beginPath()
    tick(0.14 / this.C.rimDensity * Math.PI / 180, (ca, sa, n) => {
      const m = ((n % 6) + 6) % 6
      const li = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n))
      const lo = m === 0 ? RB : RB * (0.5 + 0.35 * hash(n + 77))
      S.moveTo(ca * (this.R + 1.5), sa * (this.R + 1.5)); S.lineTo(ca * (this.R + 1.5 + li), sa * (this.R + 1.5 + li))
      S.moveTo(ca * (this.RO - 1.5), sa * (this.RO - 1.5)); S.lineTo(ca * (this.RO - 1.5 - lo), sa * (this.RO - 1.5 - lo))
    })
    S.globalCompositeOperation = 'lighter'
    S.strokeStyle = this.pal.rgba(this.pal.white, Math.min(1, 0.035 * this.C.rimBright * this.C.rimBright))
    S.lineWidth = 1.2 + 2.4 * this.C.rimBright; S.stroke()
    S.strokeStyle = this.pal.rgba(this.pal.white, Math.min(1, 0.08 * this.C.rimBright))
    S.lineWidth = 1.4; S.stroke()
    S.globalCompositeOperation = 'source-over'
    S.strokeStyle = this.pal.rgba(this.pal.white, Math.min(1, 0.88 * this.C.rimBright))
    S.lineWidth = 0.55; S.stroke()
    const arc = (r: number, lw: number, a: number) => {
      S.strokeStyle = this.pal.rgba(this.pal.white, a); S.lineWidth = lw
      S.beginPath(); S.arc(0, 0, r, -this.thV, this.thV); S.stroke()
    }
    arc(this.R, 1.5, 1); arc(this.R + RB + 3, 0.6, 0.6); arc(this.RO - RB - 3, 0.6, 0.55)
    S.globalCompositeOperation = 'lighter'; arc(this.RO, 3.5, 0.1); S.globalCompositeOperation = 'source-over'
    arc(this.RO, 1.3, 0.95)
    S.beginPath()
    tick(1 * Math.PI / 180, (ca, sa) => {
      S.moveTo(ca * (this.R - 2), sa * (this.R - 2)); S.lineTo(ca * (this.R - 5), sa * (this.R - 5))
    })
    tick(0.25 * Math.PI / 180, (ca, sa, n) => {
      const m = ((n % 20) + 20) % 20, L = m === 0 ? 9 : m % 5 === 0 ? 5 : 2.5
      S.moveTo(ca * (this.RO + 2), sa * (this.RO + 2)); S.lineTo(ca * (this.RO + 2 + L), sa * (this.RO + 2 + L))
    })
    S.strokeStyle = this.pal.rgba(this.pal.white, 0.5); S.lineWidth = 0.6; S.stroke()
    S.restore()
  }


  /* ============================================================
     对外的数据接口。引擎不知道数据从哪来，只负责把「事件」翻译成光。
     ============================================================ */

  /* 换一整副参数（live / star 两套预设之间切换） */
  setPreset(name: keyof typeof PRESETS) {
    this.C = { ...PRESETS[name] }
    this.runners = []
    for (let i = 0; i < this.C.runnerCount; i++) this.runners.push(this.newRunner(true))
    if (this.ready) this.resize()
  }

  /* 调参面板用：单改一个参数，不重建引擎。
     runnerCount 这类数量参数要同步增减流光，否则滑块拖了没反应。 */
  setParam(key: string, v: number) {
    if (!(key in this.C)) return
    const old = this.C[key]
    this.C[key] = v
    if (key === 'runnerCount') {
      const n = Math.max(0, Math.round(v))
      while (this.runners.length < n) this.runners.push(this.newRunner(true))
      if (this.runners.length > n) this.runners.length = n
    }
  }

  /* 把当前参数吐出来给面板显示（面板要知道「现在是多少」） */
  getParams(): Params { return { ...this.C } }

  /* 注入真实数字：环上数据块会轮着显示这些值，不再是 rnd() 编的。
     传 {} 就退回纯装饰模式（比如还没拉到数据的头几帧）。 */
  setFacts(f: Record<string, number>) {
    this.facts = { ...f }
    this.factKeys = Object.keys(this.facts).filter(k => Number.isFinite(this.facts[k]))
    this.factIx = 0
  }

  /* 回到当前模式的预设 —— 调乱了要能一键复原 */
  resetParams() { this.setPreset(this.mode === 'star' ? 'star' : 'live') }

  setMode(m: EngineMode) {
    if (this.mode === m) return
    this.mode = m
    this.setPreset(m === 'star' ? 'star' : 'live')
    /* 构图依赖 mode（记忆模式环更靠左），所以换模式后必须重算一次 */
    if (this.ready) this.resize()
  }

  /* ---- 光 1：一束光从圆心射向环边 ---- */
  fireStroke(s: Stroke) {
    const a = clamp(s.angle, -Math.PI / 2, Math.PI / 2)
    const tone = s.tone ?? 0
    this.pulses.push({
      c: a, v: (s.strength > 0 ? 1 : -1) * rr(0.8, 1.5) * Math.min(1, Math.abs(s.strength)),
      w: rr(0.05, 0.16), amp: clamp(Math.abs(s.strength), 0.4, 1),
      life: rr(1.2, 2.0), L: 0,
    })
    this.burstFlyers(a, tone)
  }

  fireFlock(angles: number[], strength = 1, tone: 0 | 1 | 2 = 0) {
    for (const a of angles) this.fireStroke({ angle: a, strength, tone })
  }

  private burstFlyers(a: number, tone: 0 | 1 | 2) {
    const n = 6 + ((rnd() * 10) | 0)
    for (let i = 0; i < n; i++) {
      this.flyers.push({
        a: a + gauss() * 0.02 - this.ringRot,
        len: rr(60, 240), r: this.RO + rr(0, 8),
        sp: rr(420, 900), lw: rr(0.6, 1.2), lv: tone === 2 ? 2 : 1,
        tint: tone, burst: true,
      })
    }
  }

  /* ---- 光 2：整圈一次「重拍」（开始 / 结束 / 换工作区） ---- */
  fireShock(tones: 0 | 1 | 2 = 0) {
    this.beatT = 0
    const dir = rnd() < 0.5 ? 1 : -1
    this.pulses.push({
      c: dir > 0 ? -this.thS - 0.15 : this.thS + 0.15,
      v: dir * 1.4, w: rr(0.25, 0.4), amp: 1, life: rr(1.2, 2.0), L: 0,
    })
    for (let i = 0; i < 3; i++) setTimeout(() => this.spawnFlyBurst(), i * 40)
    void tones
  }

  /* ---- 记忆星图 ---- */
  setStars(stars: Star[], links: StarLink[]) {
    const prev = this.starById
    this.stars = stars
    this.starLinks = links
    this.starById = new Map(stars.map((s) => [s.id, s]))
    /* 新来的记忆点亮一下：它出现在哪，哪就闪一下 —— 让「刚记住」有迹可循 */
    for (const s of stars) {
      if (!prev.has(s.id)) this.starPulse.set(s.id, 1)
    }
    for (const id of Array.from(this.starPulse.keys())) if (!this.starById.has(id)) this.starPulse.delete(id)
  }

  /* 外部点了一条记忆：让它亮 1.2 秒 */
  pulseStar(id: string) { this.starPulse.set(id, 1) }

  private starPos(s: Star) {
    const r = this.R * (0.16 + 0.80 * clamp(s.rad, 0, 1))
    return { x: Math.cos(s.a) * r, y: Math.sin(s.a) * r, r }
  }

  private drawStars() {
    const S = this.S
    const pal = this.pal
    if (!this.stars.length) return
    const decay = 0.982

    /* 星图是叠在光环**里面**（比环更靠近观众），所以整块要跟着相机的推近动，
       但不能像环内网线那样被视差甩开 —— 记忆是主体，得稳稳贴住画面。 */
    S.save()
    S.setTransform(this.DPR, 0, 0, this.DPR, 0, 0)
    S.translate(this.cx, this.cy)
    S.scale(this.cam.z, this.cam.z)
    S.translate(-this.cx, -this.cy)
    S.translate(this.cx, this.cy)
    S.globalCompositeOperation = 'lighter'
    S.lineCap = 'round'

    const T = this.T
    const pos = this.stars.map((s) => ({ s, p: this.starPos(s) }))
    const byId = new Map(pos.map((x) => [x.s.id, x]))

    /* ---- 边：先画，压在节点下面 ----
       一条边自己要说得出「它连的是哪两类记忆」，所以两端取混色。
       正在被点亮的节点，它的边也跟着亮 —— 顺着光找得到来龙去脉。 */
    for (const l of this.starLinks) {
      const A = byId.get(l.from), B = byId.get(l.to)
      if (!A || !B) continue
      const fa = this.starPulse.get(l.from) || 0
      const fb = this.starPulse.get(l.to) || 0
      const heat = Math.max(fa, fb)
      const mix: RGB = [
        Math.round((pal.kind[A.s.kind][0] + pal.kind[B.s.kind][0]) / 2),
        Math.round((pal.kind[A.s.kind][1] + pal.kind[B.s.kind][1]) / 2),
        Math.round((pal.kind[A.s.kind][2] + pal.kind[B.s.kind][2]) / 2),
      ]
      const dx = B.p.x - A.p.x, dy = B.p.y - A.p.y
      const dist = Math.hypot(dx, dy) || 1
      const bump = Math.min(34, dist * 0.16)
      const nx = -dy / dist, ny = dx / dist
      S.beginPath()
      S.moveTo(A.p.x, A.p.y)
      S.quadraticCurveTo(
        (A.p.x + B.p.x) / 2 + nx * bump,
        (A.p.y + B.p.y) / 2 + ny * bump,
        B.p.x, B.p.y)
      S.strokeStyle = pal.rgba(mix, Math.min(0.85, 0.13 + heat * 0.7))
      S.lineWidth = 0.7 + heat * 1.3
      S.stroke()

      /* 沿边的数据流：一小段光点在上面跑，暗示「这些记忆是连着的」 */
      if (heat > 0.15 || dist < this.R * 0.5) {
        const t = ((T * 0.22 + hashS(l.from + l.to)) % 1)
        const mt = 1 - t
        const px = mt * mt * A.p.x + 2 * mt * t * ((A.p.x + B.p.x) / 2 + nx * bump) + t * t * B.p.x
        const py = mt * mt * A.p.y + 2 * mt * t * ((A.p.y + B.p.y) / 2 + ny * bump) + t * t * B.p.y
        S.fillStyle = pal.rgba(mix, Math.min(0.9, 0.25 + heat * 0.6))
        S.beginPath(); S.arc(px, py, 1.4, 0, TAU); S.fill()
      }
    }

    /* ---- 节点 ---- */
    const baseR = clamp(this.R * 0.052, 8, 26)
    for (const { s, p } of pos) {
      const col = pal.kind[s.kind] || pal.white
      const fresh = this.starPulse.get(s.id) || 0
      const sizeK = clamp(s.size, 0.5, 1.5)
      const r = baseR * (0.55 + 0.85 * sizeK)
      /* 呼吸：每颗星按自己的相位轻轻涨落 —— 同一个画面里没有两颗同步的星，
         这是它看起来「活」而不是「贴纸」的关键。 */
      const breathe = 1 + 0.10 * Math.sin(T * 1.1 + hashS(s.id) * TAU)

      /* 外晕：三层由内到外衰减，比单层渐变厚得多，才撑得起「星」的感觉 */
      const haloR = r * (4.8 + fresh * 5.5) * breathe
      const halo = S.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloR)
      halo.addColorStop(0, pal.rgba(col, Math.min(1, 0.42 + fresh * 0.5)))
      halo.addColorStop(0.22, pal.rgba(col, Math.min(1, 0.16 + fresh * 0.3)))
      halo.addColorStop(0.55, pal.rgba(col, Math.min(1, 0.05 + fresh * 0.12)))
      halo.addColorStop(1, pal.rgba(col, 0))
      S.fillStyle = halo
      S.beginPath(); S.arc(p.x, p.y, haloR, 0, TAU); S.fill()

      /* 十字光芒：只在比较亮的星上给，不然整片就成刺猬了 */
      if (sizeK > 0.95 || fresh > 0.1) {
        const L = r * (4.2 + fresh * 3.5) * breathe
        S.strokeStyle = pal.rgba(col, Math.min(0.8, 0.22 + fresh * 0.5))
        S.lineWidth = 0.8
        S.beginPath()
        S.moveTo(p.x - L, p.y); S.lineTo(p.x + L, p.y)
        S.moveTo(p.x, p.y - L * 0.62); S.lineTo(p.x, p.y + L * 0.62)
        S.stroke()
      }

      /* 芯：实心 + 一圈细描边，屏幕小的时候靠它认位置 */
      S.fillStyle = pal.rgba(col, Math.min(1, 0.88 + fresh * 0.15))
      S.beginPath(); S.arc(p.x, p.y, r * 0.5 * breathe, 0, TAU); S.fill()
      S.strokeStyle = pal.rgba(col, Math.min(1, 0.55 + fresh * 0.4))
      S.lineWidth = 1
      S.beginPath(); S.arc(p.x, p.y, r * breathe, 0, TAU); S.stroke()

      /* 刚出现的：向外扩一圈涟漪 */
      if (fresh > 0.02) {
        S.strokeStyle = pal.rgba(col, fresh * 0.55)
        S.lineWidth = 1.4
        S.beginPath(); S.arc(p.x, p.y, r * (2.2 + (1 - fresh) * 5), 0, TAU); S.stroke()
      }
    }
    S.restore()
    S.globalCompositeOperation = 'source-over'

    for (const [id, v] of this.starPulse) {
      const nv = v * decay
      if (nv < 0.02) this.starPulse.delete(id); else this.starPulse.set(id, nv)
    }
  }

  /* 把一个屏幕坐标换算成光环的极坐标 —— 点击命中用 */
  hitAngle(clientX: number, clientY: number): number | null {
    const rect = this.stage.getBoundingClientRect()
    const sx = clientX - rect.left, sy = clientY - rect.top
    const wx = (sx - this.W / 2) / this.cam.z + this.cam.x
    const wy = (sy - this.H / 2) / this.cam.z + this.cam.y
    const dx = wx - this.cx, dy = wy - this.cy
    const d = Math.hypot(dx, dy)
    if (d < this.R * 0.9 || d > this.RO * 1.02) return null
    return Math.atan2(dy, dx)
  }

  /* 记忆星图里，屏幕上哪颗星被点到了 */
  hitStar(clientX: number, clientY: number): Star | null {
    if (this.mode !== 'star') return null
    const rect = this.stage.getBoundingClientRect()
    const sx = clientX - rect.left, sy = clientY - rect.top
    const wx = (sx - this.W / 2) / this.cam.z + this.cam.x
    const wy = (sy - this.H / 2) / this.cam.z + this.cam.y
    let best: Star | null = null, bd = 26
    for (const s of this.stars) {
      const p = this.starPos(s)
      const d = Math.hypot(wx - (this.cx + p.x), wy - (this.cy + p.y))
      if (d < bd) { bd = d; best = s }
    }
    return best
  }
}
