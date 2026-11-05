/* ============================================================
   lib/agentStream.ts —— SSE 读取层

   Chat.tsx 里 send() 和 resumeRun() 原来各有一份几乎逐行相同的代码：
   fetch → getReader → TextDecoder → 按 "\n\n" 分帧 → JSON.parse → 分派事件。
   约 170 行复制粘贴（审计指出）。除了 body 不同，两边连注释都一样。

   这一层只做**传输**，不做业务：
     · fetch / abort / HTTP 错误
     · 分帧（收到的块可能断在半行，剩下的留在 buf 等下一块）
     · JSON.parse（坏帧跳过，不能让一行脏数据掐断整条流）

   事件怎么解释、界面怎么更新，全部交给调用方的 onEvent。
   **故意不合并两段的事件处理** —— 它们本来就有差异
   （send 处理 need_confirm / suggest / plans / card，resumeRun 是简化版），
   硬合并会把差异藏起来，那才是真的引入 bug。

   为什么把这一层单独放文件而不是抽成组件内的函数：
   它不依赖任何 React state，是纯 IO。放 lib 里两处都能用，
   也方便以后单独测分帧逻辑。
   ============================================================ */

export type StreamEvent = Record<string, unknown>

export type StreamOpts = {
  /** POST 的 body；会被 JSON.stringify */
  body: Record<string, unknown>
  /** 外部用于「停一下」的 AbortController */
  signal: AbortSignal
  /** 每一个解析出来的事件 */
  onEvent: (ev: StreamEvent) => void
}

/**
 * 读完一整条 /api/agent/stream。
 *
 * 返回 true = 流正常读完；false = 中途断掉（调用方据此提示「没答完」）。
 * 异常向上抛，由调用方统一处理网络错误 / 主动 abort ——
 * 错误文案两处不同（send 会补半截字，resumeRun 不会），这属于业务，不归这里。
 */
export async function streamAgent(opts: StreamOpts): Promise<boolean> {
  const res = await fetch('/api/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)

  const rd = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let ended = false

  for (;;) {
    const { done, value } = await rd.read()
    if (done) break
    buf += dec.decode(value, { stream: true })

    /* SSE 用空行分帧；一块里可能有多帧，也可能断在半行 */
    let cut = buf.indexOf('\n\n')
    while (cut >= 0) {
      const frame = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      cut = buf.indexOf('\n\n')

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        let ev: StreamEvent
        try { ev = JSON.parse(line.slice(5).trim()) as StreamEvent } catch { continue }
        if (ev.t === 'end') ended = true
        opts.onEvent(ev)
      }
    }
  }
  return ended
}
