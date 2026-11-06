/* ============================================================
   lib/shotBus.ts —— 让「全局快捷键」能调到「课堂页的截帧」

   为什么要有这个：
     抓帧的完整逻辑（暂停、drawImage、去重、shot_frame 落库、闪光反馈）
     在 Classroom.tsx 里，而快捷键监听在 App.tsx。为了一个快捷键把整套逻辑
     复制到 App 是最糟的做法 —— 两处逻辑早晚不一致。
   所以：Classroom 挂载时把自己的 grabFrame 注册进来，App 只管调。

   同一时刻只会有一个课堂页，所以单槽就够了。
   ============================================================ */

type GrabResult = { ok: boolean; path?: string; shot?: any; error?: string }

export const shotBus: {
  /** 课堂页注册的抓帧函数；不在课堂页时为 null */
  grab: null | (() => Promise<GrabResult | null>)
  /** 抓完之后把结果交给置顶小窗（由 ShotDock 注册） */
  onShot: null | ((r: GrabResult) => void)
} = {
  grab: null,
  onShot: null,
}

/** 有课堂页就用它的抓帧，没有就返回 null（调用方自己截整屏）。 */
export async function grabViaBus(): Promise<GrabResult | null> {
  if (!shotBus.grab) return null
  try {
    const r = await shotBus.grab()
    return r || null
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) }
  }
}
