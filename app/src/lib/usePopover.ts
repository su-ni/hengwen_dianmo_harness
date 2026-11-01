import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/* 浮层的定位与避让。
 *
 * 为什么需要它：输入框在页面最底部，弹出面板天然往上长；但面板一高、
 * 或者窗口一窄，就会顶出视口上沿，或者被右侧裁掉 —— 之前那个权限选择器
 * 就是这么漏出页面的（截图里能看到它一半在视口外）。
 *
 * 做法：
 *   · 面板用 position: fixed（脱离父级 overflow 裁剪，不会被裁）
 *   · 打开时量一次触发按钮与面板尺寸，算「上/下」哪边空间够，翻到够的那边
 *   · 左右夹在视口内（8px 边距），高度不够就在面板内部滚动
 *   · 窗口缩放 / 页面滚动时重算 —— 不然滚动一下面板就飘在空气里
 */
export type PopPos = { left: number; top: number; maxH: number; up: boolean; width: number;
  /* 面板右边缘距视口右侧的空间不足时置 true —— 二级菜单要翻到左边去 */
  flipRight: boolean }

const GAP = 10
const EDGE = 8

export function usePopover(open: boolean, onClose: () => void) {
  const anchorRef = useRef<HTMLElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<PopPos | null>(null)

  const place = useCallback(() => {
    const a = anchorRef.current
    const p = popRef.current
    if (!a) return
    const ar = a.getBoundingClientRect()
    // 首帧面板还没上屏时量不到，用 0 表示「未知」，下一帧再算一次
    const w = p ? p.offsetWidth : 0
    const natural = p ? Math.max(p.scrollHeight, p.offsetHeight) : 0
    const vw = window.innerWidth
    const vh = window.innerHeight
    const spaceUp = ar.top - GAP - EDGE
    const spaceDown = vh - ar.bottom - GAP - EDGE
    // 空间够就优先往上（输入框在底部）；上面明显比下面宽裕也往上
    const nat = natural || 360            // 未知时给个上限，下一帧会修正
    const up = nat <= spaceUp || spaceUp >= spaceDown
    const avail = Math.max(160, up ? spaceUp : spaceDown)
    const maxH = Math.min(nat, avail)
    const ww = w || 320
    const left = Math.min(Math.max(EDGE, ar.left), Math.max(EDGE, vw - ww - EDGE))
    const top = up ? Math.max(EDGE, ar.top - GAP - maxH) : ar.bottom + GAP
    // 主面板右边还有多少空间？不够放二级（264px + 间距）就翻到左边
    const flipRight = left + ww + 12 + 264 > vw - EDGE
    setPos({ left, top, maxH, up, width: ww, flipRight })
  }, [])

  /* 三次测量：
     ① 打开当帧 —— 面板还没上屏，pos 为空，先按默认值给个可见位置（避免闪一下空白）；
     ② 下一帧 —— 面板已渲染，拿到真实 width/height，重算一次（关键的一次）；
     ③ 再隔一帧 —— 字体/图标落定后高度可能变，再校一次。
     少任何一次都会出现「面板看起来位置不对」或「最后一项被切」。 */
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    let r2 = 0
    const r1 = requestAnimationFrame(() => {
      place()
      r2 = requestAnimationFrame(() => place())
    })
    return () => {
      cancelAnimationFrame(r1)
      if (r2) cancelAnimationFrame(r2)
    }
  }, [open, place])

  /* 只在**弹层外**的滚动上重算位置。
     之前用 window.addEventListener('scroll', ..., true) 捕获阶段，
     等于弹层内部列表一滚也重算 —— 面板跟着跳，用户看到的就是「整块往上走」。
     现在：捕获阶段收到滚动时，先看事件目标是不是在弹层里，是就直接忽略。 */
  useEffect(() => {
    if (!open) return
    const onResize = () => place()
    const onScroll = (e: Event) => {
      const p = popRef.current
      const t = e.target as Node | null
      // 弹层内部（或目标在弹层里）的滚动不重算 —— 那是列表在自己滚，不是页面在动
      if (p && t && (p === t || p.contains(t))) return
      place()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, place])

  // 点外面 / 按 Esc 关
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const a = anchorRef.current
      const p = popRef.current
      const t = e.target as Node
      if (a && a.contains(t)) return
      if (p && p.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return { anchorRef, popRef, pos }
}
