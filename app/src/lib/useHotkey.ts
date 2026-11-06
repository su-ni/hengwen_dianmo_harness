/* ============================================================
   lib/useHotkey.ts —— 把 keys.ts 的注册表接到具体页面上

   用法（一行）：
     useHotkey('shot', grabFrame, [grabFrame])

   它自己负责：读当前绑定、判断焦点在不在输入框、preventDefault、
   卸载时解绑。调用方不再自己写 keydown。
   ============================================================ */
import { useEffect } from 'react'
import { isTyping, loadKeys, matches, type ActionId, KEY_DEFS } from './keys'

export function useHotkey(id: ActionId, fn: () => void, deps: unknown[] = [], enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const def = KEY_DEFS.find((d) => d.id === id)
    const onKey = (e: KeyboardEvent) => {
      const combo = loadKeys()[id]
      if (!combo || !matches(e, combo)) return
      // 输入框里打字时不抢键，除非这个动作自己声明可以在输入框里触发
      if (!def?.inInput && isTyping(e)) return
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled, ...deps])
}
