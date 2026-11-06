import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Logo } from '../components/Logo'
import { HaloEngine } from './halo/engine'
import { Tuner } from './halo/tuner'
import { KIND_CN } from './halo/theme'
import { pull, buildLinks, strokeOfTool, isAlive, kpisOf, kindBars, type Snapshot } from './halo/feed'
import { drawAdv, drawDiff, drawVal, drawIdx, feedRows, codeLines, routeRows, agentCells } from './halo/panels'
import { layoutField, drawField, hitCell, LANE_ORDER, type MemCell, type FieldOpts } from './halo/memoryfield'
import { PALETTE_TOKENS } from './halo/tokens'

/* ============================================================
   haloflux · 光环（第 10 章 D28/D29）

   整屏控制台，三行铺满（跟官方 lab.html 同一个骨架）：
     header  KPI 带（左边是**衡文点墨 HARNESS 的品牌** —— 这一页是这个项目的一部分）
     stage   舞台（运行时：光环 / 记忆：记忆场）
     panels  底部 8 块面板

   两副面孔，**两种笔法，一个系统**：
     运行时 —— 光环：节拍驱动的光束、圆环数据块
     记忆   —— 记忆场：横向时间轴 × 五条类型泳道，用**刻度线**画记忆
   它们共用同一套笔画（细白线 / 低亮度铺底 / 少量高亮 / 扫描），
   所以看起来是一台机器上的两个面，不是两个软件。

   视觉源头：web/halo/lab.html（Ryder191 / HALOFLUX，PolyForm Noncommercial 1.0.0）。
   ============================================================ */

type Mode = 'live' | 'mem'
const POLL = 3000
const SCAN_PERIOD = 14          // 秒：扫描线走完一趟的时间

export function Haloflux({ onExit }: { onExit?: () => void }) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const memRef = useRef<HTMLCanvasElement>(null)
  const panelRefs = useRef<Record<string, HTMLCanvasElement | null>>({})
  const engRef = useRef<HaloEngine | null>(null)
  const [mode, setMode] = useState<Mode>('live')
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [base, setBase] = useState<any>(null)
  const [picked, setPicked] = useState<MemCell | null>(null)
  const [err, setErr] = useState('')
  const snapRef = useRef<Snapshot | null>(null)
  snapRef.current = snap
  const cellsRef = useRef<MemCell[]>([])
  const modeRef = useRef<Mode>('live')
  modeRef.current = mode
  const pickedRef = useRef<MemCell | null>(null)
  pickedRef.current = picked

  /* ---- 引擎 ---- */
  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return
    let eng: HaloEngine | null = null
    try {
      eng = new HaloEngine(cv, {})
      engRef.current = eng
      eng.start()
    } catch (e) {
      setErr(String(e).slice(0, 120))
      return
    }
    return () => { eng?.destroy(); engRef.current = null }
  }, [])

  /* ---- 数据 ---- */
  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([pull(), fetch('/api/base').then((r) => r.json()).catch(() => null)])
      setSnap(s); setBase(b); setErr('')
      /* 把真实数字喂给引擎：环上那 12 种数据块原来全是 rnd() 编的示意值，
         现在轮着显示本机真数（记忆/关联/工具/向量/熟练度…）。
         只取能核对的数字，不把「0」也塞进去充数 —— 那看着像有数据其实没有。 */
      const st = s.stats || {}
      const facts: Record<string, number> = {}
      const put = (k: string, v: unknown) => {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) facts[k] = v
      }
      put('mems', s.mems?.length)
      put('links', s.links?.length)
      put('calls', s.calls?.length)
      put('core', st.layers?.core)
      put('recall', st.layers?.recall)
      put('vec', st.vector?.covered)
      put('tools', b?.tools?.count)
      engRef.current?.setFacts(facts)
    } catch (e) {
      setErr('连不上后端：' + String(e).slice(0, 80))
    }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(load, POLL)
    return () => clearInterval(t)
  }, [load])

  const links = useMemo(() => (snap ? buildLinks(snap.mems, snap.links) : []), [snap])
  const cells = useMemo(() => (snap ? layoutField(snap.mems) : []), [snap])
  cellsRef.current = cells

  /* 工具调用增量 → 一束光 */
  const lastCallId = useRef(0)
  useEffect(() => {
    const eng = engRef.current
    if (!eng || !snap) return
    if (lastCallId.current === 0) {
      lastCallId.current = snap.calls.reduce((m, c) => Math.max(m, c.id), 0)
      return
    }
    const fresh = snap.calls.filter((c) => c.id > lastCallId.current)
    lastCallId.current = snap.calls.reduce((m, c) => Math.max(m, c.id), lastCallId.current)
    fresh.reverse().forEach((c, i) => {
      setTimeout(() => { engRef.current?.fireStroke(strokeOfTool(c.name)) }, i * 90)
    })
  }, [snap])

  useEffect(() => { engRef.current?.setMode(mode === 'mem' ? 'star' : 'live') }, [mode])

  const prevRunning = useRef(0)
  useEffect(() => {
    const eng = engRef.current
    if (!eng || !snap) return
    const n = snap.bubbles.filter(isAlive).length
    if (n > prevRunning.current) eng.fireShock(0)
    prevRunning.current = n
  }, [snap])

  /* ---- 循环：底部面板 + 记忆场 ---- */
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let t = 0
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt
      const tok = PALETTE_TOKENS()
      const R = panelRefs.current
      if (R.adv) drawAdv(R.adv, { pal: tok, T: t, dt })
      if (R.diff) drawDiff(R.diff, { pal: tok, T: t, dt })
      if (R.val) drawVal(R.val, { pal: tok, T: t, dt })
      if (R.idx) drawIdx(R.idx, { pal: tok, T: t, dt })

      /* 记忆场只在记忆模式下画，而且用独立画布叠在光环上面 */
      const mcv = memRef.current
      if (mcv && modeRef.current === 'mem') {
        const r = mcv.getBoundingClientRect()
        if (r.width > 20) {
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          const w = Math.round(r.width), h = Math.round(r.height)
          if (mcv.width !== w * dpr || mcv.height !== h * dpr) {
            mcv.width = w * dpr; mcv.height = h * dpr
          }
          const x = mcv.getContext('2d') as CanvasRenderingContext2D
          x.setTransform(dpr, 0, 0, dpr, 0, 0)
          const scan = ((t % SCAN_PERIOD) / SCAN_PERIOD)
          const o: FieldOpts = { pal: tok, T: t, scan, hot: pickedRef.current?.id || null }
          drawField(x, w, h, cellsRef.current, o)
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'mem') return
    const cv = memRef.current
    if (!cv) return
    const r = cv.getBoundingClientRect()
    const hit = hitCell(e.clientX - r.left, e.clientY - r.top, r.width, r.height, cellsRef.current)
    setPicked(hit)
  }, [mode])

  const kpi = kpisOf(snap, base)
  const bars = kindBars(snap)
  const running = (snap?.bubbles || []).filter(isAlive)
  const feed = feedRows(snap?.calls || [])
  const code = codeLines(snap?.calls || [])
  const routes = routeRows(snap?.mems || [])
  const agents = agentCells(snap?.bubbles || [], snap?.mems || [], snap?.calls || [])
  const laneCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of cells) m[c.kind] = (m[c.kind] || 0) + 1
    return m
  }, [cells])
  void links

  return (
    <div className="hfx">
      {/* ================= header：品牌 + KPI ================= */}
      <header className="hfx-top">
        <div className="hfx-brand">
          <button className="hfx-back" onClick={onExit} title="回到工作区">←</button>
          <Logo size={22} tone="white" />
          <div className="hfx-brand-tx">
            <h1>衡文点墨 <em>HARNESS</em></h1>
            <p>记忆 · 运行时 · 子智能体 —— 本项目的一个面</p>
          </div>
        </div>
        <Kpi k="记忆" v={String(kpi.mems)} />
        <Kpi k="关联" v={String(kpi.links)} />
        <Kpi k="讲次" v={kpi.lessons.total ? kpi.lessons.done + '/' + kpi.lessons.total : '—'} />
        <Kpi k="到期词" v={String(kpi.dueToday)} />
        <Kpi k="在跑" v={String(kpi.running)} hot />
      </header>

      {/* ================= stage ================= */}
      <section className="hfx-stage">
        {/* 运行时：光环。记忆模式时**整个让位** —— 两副面孔不是叠加，是切面。
            叠在一起时记忆块永远被环压着（实测五轮），因为它们在抢同一块屏幕。
            切面之后，记忆场拿到完整的画布，才谈得上"好看"。 */}
        <canvas ref={cvRef} className={'hfx-cv' + (mode === 'live' ? '' : ' off')} />
        <canvas
          ref={memRef}
          className={'hfx-mem-cv' + (mode === 'mem' ? ' on' : '')}
          onClick={onCanvasClick}
        />
        <div className="hfx-scan" />

        <div className="hfx-modes">
          <button className={mode === 'live' ? 'on' : ''} onClick={() => { setMode('live'); setPicked(null) }}>运行时</button>
          <button className={mode === 'mem' ? 'on' : ''} onClick={() => setMode('mem')}>记忆场</button>
        </div>

        {/* 调参面板：官方 56 参数，右上角浮层，默认收起 */}
        <Tuner
          get={() => engRef.current?.getParams() ?? {}}
          set={(k, v) => engRef.current?.setParam(k, v)}
          reset={() => engRef.current?.resetParams()}
        />

        {/* 记忆模式左侧的泳道说明：把「怎么读这张图」直接印在图上，不另开一栏 */}
        {mode === 'mem' && (
          <div className="hfx-memhead">
            <b>{kpi.mems} 条记忆 · {kpi.links} 条关联</b>
            <span>从上到下：从新到旧 · 左边是类型 · 白杠是「常驻」（每轮都进模型提示）</span>
            {snap?.stats?.layers ? (
              <div className="hfx-lay">
                <i className="lay-core" style={{ flex: Math.max(1, snap.stats.layers.core) }}>常驻 {snap.stats.layers.core}</i>
                <i className="lay-recall" style={{ flex: Math.max(1, snap.stats.layers.recall) }}>近期 {snap.stats.layers.recall}</i>
                <i className="lay-arch" style={{ flex: Math.max(1, snap.stats.layers.archival) }}>归档 {snap.stats.layers.archival}</i>
              </div>
            ) : null}
          </div>
        )}

        <div className="hfx-status">
          <b>{mode === 'mem' ? kpi.mems + ' 条记忆 · ' + LANE_ORDER.length + ' 类' : (running.length ? running.length + ' 个任务在跑' : '待命中')}</b>
          <span>{mode === 'mem' ? '点任意一条看它记住了什么' : '每一束光都是一次真实的工具调用'}</span>
        </div>

        {mode === 'mem' && picked && (
          <div className="hfx-mem">
            <b className={'hfx-mem-k k-' + picked.kind}>{KIND_CN[picked.kind as keyof typeof KIND_CN] || picked.kind}</b>
            <span>{picked.content}</span>
            <i>{picked.created}</i>
          </div>
        )}
        {err && <div className="hfx-err">{err}</div>}
      </section>

      {/* ================= panels ================= */}
      <section className="hfx-panels">
        <Panel h="调查流水 / 工具调用">
          <div className="hfx-feed">
            {feed.length === 0 && <div className="hfx-dim">还没跑过工具</div>}
            {feed.map((r, i) => (
              <div key={i} className={i === feed.length - 1 ? 'last' : ''}>
                <span className="n">{r.n}</span>
                <span className={'vb ' + r.vb}>{r.vb}</span>
                {r.text}
              </div>
            ))}
          </div>
        </Panel>

        <Panel h="对流 / 微观粒子">
          <canvas ref={(el) => { panelRefs.current.adv = el }} className="hf-cv" />
        </Panel>

        <Panel h="方法工作区">
          <div className="hfx-code">
            {code.map((l, i) => (
              <div key={i}>
                <span className="ln">{l.ln}</span>
                <span className="fn">{l.fn}</span>
                <span className="op">{l.op}</span>
              </div>
            ))}
            <div><span className="ln">{String(code.length + 1).padStart(3, '0')}</span><span className="caret" /></div>
          </div>
        </Panel>

        <Panel h="计划 / 实际 差分场" cap="同一天 · 计划 vs 做了的">
          <canvas ref={(el) => { panelRefs.current.diff = el }} className="hf-cv" />
        </Panel>

        <Panel h="记忆来源 / 入库路线" cap="提取 → 入库 → 可查">
          <div className="hfx-routes">
            <span className="h">类型</span><span className="h">提</span><span className="h">入</span><span className="h">查</span>
            {routes.map((r) => (<RouteRow key={r.name} name={r.name} st={r.st} />))}
          </div>
        </Panel>

        <Panel h="校验 / 样本缓冲" cap="本机实测 · 逐次累积">
          <canvas ref={(el) => { panelRefs.current.val = el }} className="hf-cv" />
        </Panel>

        <Panel h="子智能体 / 派发" cap="真实工具流水 · 按路聚合">
          <div className="hfx-agents">
            {agents.map((a) => (
              <div key={a.id} className="ag">
                <span className="id">{a.id}</span>
                <span className="rl">{a.role}</span>
                <span className="cells">
                  {[0, 1, 2, 3, 4, 5].map((k) => (
                    <i key={k} className={k < a.done ? 'on' : k === a.done ? 'cur' : ''} />
                  ))}
                </span>
                <span className={'st' + (a.st === '在跑' ? ' w' : '')}>{a.st}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel h="记忆系统 / 三层 + 向量" cap="常驻进提示 · 近期滚动 · 归档只靠检索">
          <div className="hfx-sys">
            <div className="ln"><span>常驻 core</span><b>{snap?.stats?.layers?.core ?? 0}</b></div>
            <div className="ln"><span>近期 recall</span><b>{snap?.stats?.layers?.recall ?? 0}</b></div>
            <div className="ln"><span>归档 archival</span><b>{snap?.stats?.layers?.archival ?? 0}</b></div>
            <div className="vs">
              <span>向量 {snap?.stats?.vector?.dim ?? 0} 维</span>
              <span className="vf">{snap?.stats?.vector?.covered ?? 0}/{snap?.stats?.vector?.total ?? 0}</span>
            </div>
            <div className="vbar">
              <i style={{ width: Math.round(((snap?.stats?.vector?.covered ?? 0) / Math.max(1, snap?.stats?.vector?.total ?? 1)) * 100) + '%' }} />
            </div>
          </div>
        </Panel>
      </section>
    </div>
  )
}

function Panel({ h, cap, children }: { h: string; cap?: string; children: React.ReactNode }) {
  return (
    <div className="hf-p">
      <h3>{h}</h3>
      <div className="hf-body">{children}</div>
      {cap && <div className="hf-cap">{cap}</div>}
    </div>
  )
}

function Kpi({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div className="hfx-kpi">
      <div className="k">{k}</div>
      <div className={'v' + (hot ? ' hot' : '')}>{v}</div>
      <div className="seg"><i /></div>
    </div>
  )
}

function RouteRow({ name, st }: { name: string; st: number }) {
  return (
    <>
      <span className="nm">{name}</span>
      {[0, 1, 2].map((i) => (
        <span key={i}><i className={'hfx-chip' + (i < st ? ' done' : i === st ? ' on' : '')} /></span>
      ))}
    </>
  )
}
