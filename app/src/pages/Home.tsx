import { useEffect, useMemo, useRef, useState } from 'react'
import { callTool, loadBase, type Base } from '../lib/api'
import { Icon } from '../components/Icon'
import { Logo } from '../components/Logo'
import { ModelEffortPicker } from '../components/ModelEffortPicker'
import { PermPicker } from '../components/PermPicker'
import { CommandPalette, detectCmd, type CmdItem } from '../components/CommandPalette'
import { UsageBar } from '../components/UsageBar'
import { TurnRail, turnsOf } from '../components/TurnRail'
import { ContextMenu, ConfirmBox, type MenuItem } from '../components/ContextMenu'
import { Chat } from '../components/Chat'
import { Onboarding } from '../components/Onboarding'
import { ToolPanel, type ToolCall } from '../components/ToolPanel'
import {
  start as asrStart, stop as asrStop, cancel as asrCancel,
  subscribe as asrSubscribe, takeText as asrTakeText,
  snapshot as asrSnapshot, clearError as asrClearError,
  type AsrState,
} from '../lib/recorder'


/* ================= 首屏（工作区列表 + 对话）=================
 *
 * 左栏：品牌 + 新会话 + 菜单 + 工作区列表 + 底部
 * 右侧：标与标语居中，输入框在其下方；发出第一句后标消失、输入框下移吸底。
 *
 * 输入区是**首屏自己的 dm-box**（样式见 home-dock.css），与工作区内的
 * 会话页共用同一个底层（都调 agent_turn、都有 +/@/权限/模型/麦克风/发送），
 * 但版式各随其位：首屏是封面，会话页是工作区。
 */

type WS = {
  id: string
  name: string
  kind: string
  exam_date?: string | null
  minutes_per_day?: number | null
  subjects?: { subject_id: string; lessons_per_day: number }[]
  modules?: string[]
  archived?: number
}

type Msg = { role: 'user' | 'assistant'; text: string; meta?: any; trace?: any[]; steps?: any[]; streaming?: boolean }

const KIND_CN: Record<string, string> = { study: '学习', exam: '应试', hobby: '兴趣' }

const atItems = [
  { k: '@本机文件', label: '本机文件', hint: '把某个文件的路径写进这句话', kind: 'file' },
  { k: '@工作区文件', label: '工作区文件', hint: '这个工作区 uploads 里的东西', kind: 'file' },
  { k: '@课程讲次', label: '课程讲次', hint: '引用某一讲（视频 / 讲义）', kind: 'lesson' },
  { k: '@笔记', label: '笔记', hint: '引用这个工作区的某条笔记', kind: 'note' },
  { k: '@截图', label: '截图', hint: '课堂截帧 / 画布导出的图', kind: 'shot' },
  { k: '@题库', label: '题库', hint: '引用某个题源或题号', kind: 'bank' },
]

const slashItems = [
  { k: '/压缩', label: '压缩上下文', hint: '把长对话折成摘要，省窗口', kind: 'cmd' },
  { k: '/模型', label: '切换模型', hint: '换提供商 / 推理等级', kind: 'cmd' },
  { k: '/计划', label: '排学习计划', hint: '按考试日期拆到每天', kind: 'cmd' },
  { k: '/复习', label: '今天复习什么', hint: '按到期与错因排队', kind: 'cmd' },
  { k: '/导出', label: '导出这段对话', hint: '存成本机文件', kind: 'cmd' },
]

/* 第 i 条消息属于第几轮：数它前面（含自己）有几条 user。
   给 data-turn 用 —— 刻度轨点击要靠它定位。 */
/* 安全取字符串：会话行的 updated_at / title 有可能是 null 或数字，
   直接 .slice() 会让整个对话区渲染崩掉（实测 TypeError: t.slice is not a function）。 */
function tstr(v: any): string {
  return v == null ? '' : String(v)
}

function turnIndexOf(msgs: { role: string }[], i: number): number {
  let n = 0
  for (let k = 0; k <= i && k < msgs.length; k++) {
    if (msgs[k].role === 'user') n += 1
  }
  return n
}

function daysTo(d?: string | null): number | null {
  if (!d) return null
  const t = Date.parse(String(d).replace(/[-/]/g, '/'))
  if (!isFinite(t)) return null
  return Math.ceil((t - Date.now()) / 86400000)
}

export function Home({
  base, onOpen, onGo,
}: {
  base: Base | null
  onOpen: (wid: string) => void
  onGo?: (p: any) => void
}) {
  /* base 的本地副本：新建/切工作区后要立刻反映，不能等轮询 */
  const [baseLocal, setBaseLocal] = useState<Base | null>(base)
  useEffect(() => { if (base) setBaseLocal(base) }, [base])
  const BB: any = baseLocal || base || {}
  /* 默认展开当前工作区：不展开的话会话列表是折叠的，
     用户会觉得「工作区下面根本没有会话」。只在该工作区还没展开过时设一次。 */
  const autoOpenedRef = useRef('')
  useEffect(() => {
    const id = BB?.ws?.id || ''
    if (!id || autoOpenedRef.current === id) return
    autoOpenedRef.current = id
    openOne(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [BB?.ws?.id])
  /* 当前工作区一变就重拉会话（含刷新后、从别处切过来的情况） */
  useEffect(() => {
    if (BB?.ws?.id) reloadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [BB?.ws?.id])
  const [list, setList] = useState<WS[]>(() => ((base as any)?.workspaces as WS[]) || [])
  /* 展开的工作区 id 集合 —— 允许**同时展开多个**。
     之前是单个 string，展开一个就把上一个顶掉，看两个工作区的会话得来回点。 */
  const [openIds, setOpenIds] = useState<string[]>([])
  const isOpen = (id: string) => openIds.includes(id)
  const toggleOpen = (id: string) =>
    setOpenIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  const openOne = (id: string) =>
    setOpenIds((prev) => prev.includes(id) ? prev : [...prev, id])
  const [mk, setMk] = useState(false)
  const [mkName, setMkName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [text, setText] = useState('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [sending, setSending] = useState(false)
  const [plus, setPlus] = useState(false)
  const [at, setAt] = useState(false)
  const [atts, setAtts] = useState<{ name: string; path: string; size: number; kind: string }[]>([])
  const [cmdOpen, setCmdOpen] = useState(false)
  const [cmdQ, setCmdQ] = useState('')
  const [cmdIdx, setCmdIdx] = useState(0)
  /* 面板模式：'+' 全出 / '/' 只指令 / '@' 只引用 */
  const [cmdMode, setCmdMode] = useState<'' | '+' | '/' | '@'>('+')
  /* 历史读回来之前不要闪「空态封面」：否则一进来先看到标语，
     半秒后被历史顶掉，像闪了一下。 */
  const [loaded, setLoaded] = useState(false)
  const [sid, setSid] = useState('')
  const [newId, setNewId] = useState('')
  /* 右键菜单 / 确认框状态 */
  const [menu, setMenu] = useState<
    { kind: 'ws'; id: string; x: number; y: number }
    | { kind: 'sess'; id: string; x: number; y: number }
    | null
  >(null)
  const [delWs, setDelWs] = useState<{ id: string; name: string; nSess: number } | null>(null)
  const [delPurge, setDelPurge] = useState(false)
  const [renaming, setRenaming] = useState<{ kind: 'ws' | 'sess'; id: string; v: string } | null>(null)
  const [delSess, setDelSess] = useState<{ id: string; title: string } | null>(null)
  /* 右栏工具轨迹：AI 调工具时自动滑出，可手动收起 */
  /* chatKey 变化 = 让 Chat 重新挂载（重新读当前会话）。
     「新会话」按钮必须走这条路：清 Home 自己的 msgs 没用，
     对话区是 Chat，它有自己的 msgs。 */
  const [chatKey, setChatKey] = useState(0)
  /* 新手引导：只有「这台机器上还没引导过」才出现。
     base 里带 onboarded 字段，后端 kv 说了算 —— 换浏览器不会再被引导一遍。 */
  const [showOb, setShowOb] = useState(false)
  useEffect(() => {
    if (BB && (BB as any).onboarded === false) setShowOb(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [BB && (BB as any).onboarded])
  const [tools, setTools] = useState<ToolCall[]>([])
  const [tpOpen, setTpOpen] = useState(false)
  const [tpManualOff, setTpManualOff] = useState(false)
  /* 与 tpManualOff 同步的 ref：SSE 回调是长时间运行的闭包，
     读 state 会拿到过期值，必须读 ref。 */
  const manualOffRef = useRef(false)
  /* 左栏：搜索 / 视图 / 排序 */
  const [q, setQ] = useState('')
  const [view, setView] = useState<'tree' | 'flat'>(
    () => (localStorage.getItem('sd.ws.view') as 'tree' | 'flat') || 'tree')
  const [sort, setSort] = useState<'recent' | 'created' | 'name'>(
    () => (localStorage.getItem('sd.ws.sort') as any) || 'recent')
  /* 语音输入：与 Chat 用的是同一个 recorder（本机转写，边说边出字） */
  const [asr, setAsr] = useState<AsrState>(() => asrSnapshot())
  useEffect(() => asrSubscribe(setAsr), [])
  async function onMic() {
    if (asr.phase === 'recording') {
      await asrStop()
      const t = asrTakeText()
      if (t) setText((v) => (v ? v + t : t))
      return
    }
    if (asr.phase === 'transcribing') return
    try { await asrStart() } catch { /* recorder 自己会把错误放进 asr.error */ }
  }
  /* 最近会话：新会话按钮的意义只有看到这张列表才成立
     （旧会话留在这里，随时切回去）。 */
  const [sessions, setSessions] = useState<any[]>([])

  useEffect(() => { localStorage.setItem('sd.ws.view', view) }, [view])
  useEffect(() => { localStorage.setItem('sd.ws.sort', sort) }, [sort])

  useEffect(() => {
    const fromBase: WS[] = (BB?.workspaces as WS[]) || []
    setList((prev) => {
      /* 合并而不是覆盖：刚新建的工作区可能还没进 base（轮询有延迟），
         直接覆盖会让它「消失」。以 base 为准，但保留本地新增的。 */
      const ids = new Set(fromBase.map((w) => w.id))
      const extra = prev.filter((w) => !ids.has(w.id))
      return extra.length ? [...extra, ...fromBase] : fromBase
    })
  }, [base])

  /* 进来先把上一次的对话读回来 —— 「退出又不见」的根因就是没读。
     数据本来就在本机 sessions/session_events 里（agent_turn 落库）。
     没有历史就开一条新会话（空态：标 + 标语 + 输入框）。 */
  useEffect(() => {
    let alive = true
    ;(async () => {
      const r = await callTool<any>('agent_history', { limit: 80 }).catch(() => null)
      if (!alive) return
      const rows: any[] = (r?.ok && (r.data as any)?.messages) || []
      const out: Msg[] = []
      rows.forEach((x) => {
        const role = x.role === 'user' ? 'user' : 'assistant'
        const t = String(x.content ?? x.text ?? '')
        if (!t.trim()) return
        out.push({
          role, text: t,
          meta: x.meta || undefined,
          trace: x.trace || x.steps || [],
        })
      })
      if (out.length) setMsgs(out)
      else {
        const n = await callTool<any>('session_new', {}).catch(() => null)
        if (alive && n?.ok) setSid((n.data as any)?.id || '')
      }
      if (alive) setLoaded(true)
      const sl = await callTool<any>('session_list', { limit: 60 }).catch(() => null)
      if (alive && sl?.ok) {
        const rows = ((sl.data as any)?.sessions || []).filter((x: any) => !x.archived)
        mergeSessions(String(((BB as any)?.ws || {}).id || ''), rows)
      }
    })()
    return () => { alive = false }
  }, [])

  const cur = (BB?.ws as WS | null) || null
  const subjectsAll: any[] = BB?.subjects || []
  /* 工作区列表：搜索 + 排序。会话也算进搜索范围（记得住「那次聊的内容」）。 */
  const shown = useMemo(() => {
    let arr = list.filter((w) => !w.archived)
    const kw = q.trim().toLowerCase()
    if (kw) {
      arr = arr.filter((w) =>
        String(w.name || '').toLowerCase().includes(kw)
        || sessions.filter((x) => x.workspace_id === w.id)
          .some((x) => String(x.title || '').toLowerCase().includes(kw)))
    }
    arr = arr.slice().sort((a, b) => {
      if (sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
      if (sort === 'created') return String(a.id).localeCompare(String(b.id))
      const ta = sessions.find((x) => x.workspace_id === a.id)?.updated_at || ''
      const tb = sessions.find((x) => x.workspace_id === b.id)?.updated_at || ''
      return String(tb).localeCompare(String(ta)) || String(b.id).localeCompare(String(a.id))
    })
    return arr
  }, [list, q, sort, sessions])
  /* 「未归类」伪工作区：库里 workspace_id 还空着的会话（早期聊天）收在这里，
     不单开「最近会话」一块 —— 会话一律挂在某个工作区下面。 */
  const looseCount = sessions.filter((x) => !x.workspace_id).length
  const started = loaded && msgs.length > 0
  /* 最后一条带 meta 的助手消息 —— 状态条读它（跟会话页同一套口径） */
  /* 轮次导航：每条 user 消息开一轮，轨道右侧竖排刻度。
     首屏原来没有这个（刻度只做进了 Chat），现在补上 —— 长对话里
     没有它就只能一直往上滚。 */
  /* 拉一次当前工作区的会话列表。切工作区/新建会话后都要调 ——
     只在挂载时拉一次的话，切过去看到的还是上一次的（空）列表，
     表现就是「工作区下面没有会话」。 */
  /* 把一个工作区的会话合并进 state（只替换这一段，不动别的区）。
     所有「拉会话」的地方都走它 —— 各自写一份必然有一处漏成整体替换。 */
  const mergeSessions = (wid: string, rows: any[], full = false) => {
    if (full) {
      /* 全量拉取（all_workspaces）：rows 已经是所有区的，直接换。
         但要保留前端刚乐观插入、后端还没返回的那条。 */
      setSessions((prev: any[]) => {
        const ids = new Set(rows.map((x: any) => x.id))
        const fresh = prev.filter((x) => !ids.has(x.id) && String(x.id).startsWith('s-'))
        return fresh.length ? [...fresh, ...rows] : rows
      })
      return
    }
    setSessions((prev: any[]) => {
      const others = prev.filter((x) => String(x.workspace_id || '') !== wid)
      const ids = new Set(rows.map((x: any) => x.id))
      const merged = [...rows]
      others.forEach((x) => { if (!ids.has(x.id)) merged.push(x) })
      return merged
    })
  }

  /* 拉当前工作区的会话。
     **必须合并，不能整体替换**：session_list 只返回当前工作区的会话，
     直接 setSessions(rows) 会把其它工作区已有的会话从 state 里抹掉 ——
     表现就是「进了 A 工作区，B/C 下面的对话全变成『还没有对话』」。
     所以：只把「当前工作区」这一段换成新的，别的区原样留着。 */
  const reloadSessions = async () => {
    try {
      const r = await fetch('/api/tool/session_list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        /* all_workspaces：左栏要按工作区分组展示，必须一次拿全。
           不传的话只回当前区，别的区永远显示「还没有对话」。 */
        body: JSON.stringify({ args: { limit: 200, all_workspaces: true } }),
      }).then((x) => x.json())
      const rows = ((r && r.data && r.data.sessions) || []).filter((x: any) => !x.archived)
      mergeSessions(String(cur?.id || BB?.ws?.id || ''), rows, true)
      return rows
    } catch {
      return []
    }
  }

  /* 这个工作区名下的会话 */
  const sessionsOf = (wid: string) =>
    sessions.filter((x: any) => (x.workspace_id || '') === wid
      || (wid === '__loose' && !x.workspace_id))

  const subjName = (id: string) => {
    const s = subjectsAll.find((x) => x.id === id)
    return (s && (s.name || s.id)) || id
  }

  /* 新会话 = 开一条新的空会话（旧的留在上面列表里，点一下能切回来）。
     这就是「新会话」按钮的实际用途。 */
  async function newSession() {
    /* 顺序很重要：
       1) 后端开一条新会话（自动挂在当前工作区下）
       2) 把「当前会话」指针指过去 —— 不指的话 Chat 重挂载后读的还是旧的
       3) bump chatKey 让 Chat 重新挂载 → 读到这条空的新会话 → 显示空态封面
    */
    const r = await callTool<any>('session_new', {}).catch(() => null)
    /* 注意层级：callTool 返回 {ok, data:{ok, id, ...}}，所以 id 在 data.data.id。
       之前写成 r.data.id 取到空 → 后面的 session_switch 被跳过 →
       指针没切 → Chat 重新挂载后读的还是旧会话（点了「新会话」没反应）。 */
    const d: any = (r as any)?.data || {}
    const id = String(d?.id || d?.data?.id || '')
    if (id) {
      await callTool<any>('session_switch', { sid: id }).catch(() => null)
      setSid(id)
      /* 立刻把这条新会话插进左栏（乐观更新）：不用等 session_list 回来，
         点了就得看见它出现在当前工作区下面 —— 哪怕还没说过一句话。 */
      const widNow = String(cur?.id || BB?.ws?.id || '')
      setNewId(id)
      setSessions((prev: any[]) => [
        { id, title: '', workspace_id: widNow, events: 0, updated_at: '', archived: 0 },
        ...prev.filter((x: any) => x.id !== id),
      ])
      /* 立刻把当前工作区展开 —— 不展开的话新会话插进去了也看不见，
         看起来就像「点了没反应」。 */
      if (widNow) openOne(widNow)
    }
    setErr('')
    setTools([]); setTpOpen(false)
    setTpManualOff(false); manualOffRef.current = false
    /* 通知 Chat 切到这条新会话（它自己会清消息并重载列表）——
       不重挂载，所以输入框不会再抽搐。 */
    window.dispatchEvent(new CustomEvent('sd:new-session', { detail: { sid: id } }))
    const sl = await callTool<any>('session_list', { limit: 60 }).catch(() => null)
    if (sl?.ok) {
      const rows = ((sl.data as any)?.sessions || []).filter((x: any) => !x.archived)
      /* 合并：后端返回的为准，但刚才那条若被过滤掉（0 事件不返回）要补回来 */
      setSessions((prev: any[]) => {
        const ids = new Set(rows.map((x: any) => x.id))
        const keep = prev.filter((x: any) => !ids.has(x.id) && x.id === id)
        return [...keep, ...rows]
      })
    }
  }

  /* 切到某个工作区：不只是设当前，还要让左栏与对话区立刻跟上。
     不刷新本地 base 的话 wsKey 不变 → Chat 不会重读 →
     表现就是「进了别的工作区，看到的还是同一个对话」。 */
  async function selectWs(wid: string) {
    const r = await fetch('/api/ws/' + encodeURIComponent(wid) + '/select',
      { method: 'POST' }).then((x) => x.json()).catch(() => ({ ok: false }))
    if (!r?.ok) { setErr('切不过去'); return }
    try {
      const nb = await loadBase(true)
      setBaseLocal(nb)
    } catch { /* 忽略 */ }
    setBaseLocal((prev: any) => ({
      ...(prev || {}),
      ws: r.current || (prev?.ws || {}),
    }))
    /* 切过去之后重拉会话列表：不重拉的话左栏还是上一个工作区的会话。 */
    await reloadSessions()
  }

  /* 切回某条旧会话：读它的历史塞进对话区 */
  async function openSession(id: string) {
    const sw = await callTool<any>('session_switch', { sid: id }).catch(() => null)
    if (sw && sw.ok === false) { setErr(sw.error || '切不过去'); return }
    setSid(id)
    const r = await callTool<any>('agent_history', { limit: 80 }).catch(() => null)
    const rows: any[] = (r?.ok && (r.data as any)?.messages) || []
    const out: Msg[] = []
    rows.forEach((x) => {
      const t = String(x.content ?? x.text ?? '')
      if (!t.trim()) return
      out.push({ role: x.role === 'user' ? 'user' : 'assistant', text: t,
        meta: x.meta || undefined, trace: x.trace || x.steps || [] })
    })
    setMsgs(out)
  }

  /* ---------------- 工作区操作 ---------------- */
  async function patchWs(id: string, body: any) {
    const r = await fetch('/api/ws/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json()).catch(() => ({ ok: false }))
    if (r?.ok) {
      setList((l) => l.map((w) => (w.id === id ? { ...w, ...body } : w)))
    }
    return r
  }

  async function doRename() {
    if (!renaming) return
    const v = renaming.v.trim()
    if (!v) { setRenaming(null); return }
    if (renaming.kind === 'ws') await patchWs(renaming.id, { name: v })
    else await callTool('session_rename', { sid: renaming.id, title: v })
    if (renaming.kind === 'sess') {
      setSessions((ss) => ss.map((x) => (x.id === renaming.id ? { ...x, title: v } : x)))
    }
    setRenaming(null)
  }

  async function doArchive(id: string, flag: boolean) {
    await patchWs(id, { archived: flag ? 1 : 0 })
    if (flag) setList((l) => l.map((w) => (w.id === id ? { ...w, archived: 1 } : w)))
  }

  async function doDeleteWs() {
    if (!delWs) return
    const url = '/api/ws/' + encodeURIComponent(delWs.id)
      + '?files=0&purge=' + (delPurge ? 1 : 0)
    const r = await fetch(url, { method: 'DELETE' })
      .then((x) => x.json()).catch(() => ({ ok: false }))
    setDelWs(null); setDelPurge(false)
    if (!r?.ok) { setErr('删不掉：' + (r?.error || '未知原因')); return }
    setList((l) => l.filter((w) => w.id !== delWs.id))
    setSessions((ss) => (delPurge ? ss.filter((x) => x.workspace_id !== delWs.id) : ss))
  }

  async function doDeleteSess() {
    if (!delSess) return
    const r = await callTool<any>('session_delete', { sid: delSess.id })
    const id = delSess.id
    setDelSess(null)
    if (!r.ok) { setErr(r.error || '删不掉'); return }
    setSessions((ss) => ss.filter((x) => x.id !== id))
    if (id === sid) setMsgs([])
  }

  function copySessLink(id: string) {
    const link = location.origin + location.pathname + '#index?sid=' + id
    navigator.clipboard?.writeText(link).catch(() => {})
  }

  async function doExport(id: string) {
    const r = await callTool<any>('ws_export', { wid: id })
    if (r.ok) setErr('')
  }

  async function createWs() {
    const name = mkName.trim()
    if (!name) { setErr('先给它起个名字'); return }
    setBusy(true); setErr('')
    const resp = await fetch('/api/ws', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, subjects: [] }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e) }))
    setBusy(false)
    if (!resp?.ok) { setErr(resp?.error || '新建失败'); return }
    /* 新建完**留在列表里**，不替用户决定「进去了」。
       要进去请自己点「进入工作区」—— 这一步本来就该由人决定。 */
    setList((l) => [resp.ws, ...l])
    setMk(false); setMkName('')
    setNewId(resp.ws.id)      // 高亮一下刚建的那条，方便找到
    /* 强制刷一次 base：不刷的话左栏名字和「当前工作区」要等 20 秒轮询才变，
       看起来像「建了但没生效」。 */
    try {
      const nb = await loadBase(true)
      setBaseLocal(nb)
    } catch { /* 刷不动也不影响已建成的工作区 */ }
    // 兜底：不管 base 刷没刷成功，本地立刻把当前工作区指过去
    setBaseLocal((prev: any) => {
      const cur = { ...(prev?.ws || {}), id: resp.ws.id, name: resp.ws.name }
      const wsList = (prev?.workspaces || []).some((w: any) => w.id === resp.ws.id)
        ? (prev?.workspaces || [])
        : [resp.ws, ...(prev?.workspaces || [])]
      return { ...(prev || {}), ws: cur, workspaces: wsList }
    })
    openOne(resp.ws.id)       // 顺手展开它的详情（但不进入）
  }

  function insertRef(what: string) {
    setText((t) => (t ? t + ' ' : '') + '@' + what)
  }

  function pickFiles(dir = false) {
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.multiple = true
    if (dir) (inp as any).webkitdirectory = true
    inp.onchange = async () => {
      const fs = inp.files
      if (!fs || !fs.length) return
      for (const f of Array.from(fs)) {
        try {
          const r = await fetch('/api/inbox?name=' + encodeURIComponent(f.name), {
            method: 'POST', body: f,
          }).then((x) => x.json())
          if (r && r.ok) {
            setAtts((a) => [...a, { name: r.name || f.name, path: r.path,
              size: r.size ?? f.size, kind: r.kind || 'file' }])
          }
        } catch { /* 单个失败不拦住其他的 */ }
      }
    }
    inp.click()
  }

  /* 命令面板条目：添加 / 指令两组，每一项都真干事。 */
  const cmds: CmdItem[] = [
    {
      k: 'file', cn: '文件', en: 'file', hint: '任意格式，可多选',
      group: '添加', icon: 'file', run: () => pickFiles(false),
    },
    {
      k: 'dir', cn: '文件夹', en: 'dir', hint: '整个目录收进来',
      group: '添加', icon: 'dir', run: () => pickFiles(true),
    },
    {
      k: 'shots', cn: '截图库', en: 'shots', hint: '课堂截帧 / 画布导出',
      group: '添加', icon: 'shots', run: () => onGo && onGo('shots'),
    },
    {
      k: 'compress', cn: '压缩', en: 'compact', hint: '压缩以上对话内容',
      group: '指令', icon: 'compress', run: () => { callTool('agent_compact', {}, { write: true }).catch(() => {}) },
    },
    {
      k: 'model', cn: '模型', en: 'model', hint: '选择本次会话使用的模型',
      group: '指令', icon: 'model', run: () => setCmdOpen(false),
    },
    {
      k: 'export', cn: '导出', en: 'export', hint: '将当前会话导出为文件',
      group: '指令', icon: 'export',
      run: () => {
        const body = msgs.map((m) => '## '
          + (m.role === 'user' ? '我' : '助手')
          + '\n\n' + (m.text || '')).join('\n\n')
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }))
        a.download = 'session-' + Date.now() + '.md'
        a.click()
      },
    },
    {
      k: 'plan', cn: '计划', en: 'plan', hint: '按考试日期拆到每天',
      group: '指令', icon: 'plan', run: () => setText('帮我按考试日期排一个学习计划'),
    },
  ]





  return (
    <div className="dhome">
      <aside className="drail">
        <div className="dr-head">
          <Logo size={30} tone="white" />
          <b>衡文点墨</b>
          <span className="dr-tag">HARNESS</span>
        </div>

        <button className="dr-new" onClick={() => { newSession() }}>
          <Icon n="plus" size={16} /> 新会话
        </button>

        <nav className="dr-menu">
          {/* 首屏只放「全局」的东西。今日/课堂/练习/画布都属于某个工作区 ——
              还没进去就摆出来，等于让人随便挑一个工作区进去，没有意义。
              那几项在进入工作区之后的左栏里。 */}
          <button className="dr-item" onClick={() => onGo && onGo('skills')}>
            <Icon n="stack" size={17} /><span>技能中心</span>
          </button>
          <button className="dr-item" onClick={() => onGo && onGo('agent')}>
            <Icon n="agent" size={17} /><span>设置</span>
          </button>
        </nav>

        <div className="dr-sec">
          <span>工作区</span>
          <div className="dr-tools">
            <button className={'dr-tool' + (q ? ' on' : '')} title="搜索工作区与会话"
              onClick={() => {
                const el = document.getElementById('dr-search') as HTMLInputElement | null
                el?.focus()
              }}>
              <Icon n="search" size={13} />
            </button>
            <button className={'dr-tool' + (view === 'flat' ? ' on' : '')}
              title={view === 'tree' ? '切到平铺' : '切到树形'}
              onClick={() => setView(view === 'tree' ? 'flat' : 'tree')}>
              <Icon n={view === 'tree' ? 'stack' : 'courses'} size={13} />
            </button>
            <button className="dr-tool"
              title={'排序：' + (sort === 'recent' ? '最近使用' : sort === 'created' ? '创建时间' : '名字')}
              onClick={() => setSort(sort === 'recent' ? 'created' : sort === 'created' ? 'name' : 'recent')}>
              {sort === 'recent' ? '近' : sort === 'created' ? '新' : '名'}
            </button>
            <button className="dr-add" title="新建工作区" onClick={() => setMk(true)}>
              <Icon n="plus" size={14} />
            </button>
          </div>
        </div>

        <div className={'dr-searchwrap' + (q ? ' has' : '')}>
          <input id="dr-search" className="dr-search" placeholder="搜工作区 / 会话"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }} />
          {q ? (
            <button className="dr-searchx" onClick={() => setQ('')} title="清空">
              <Icon n="x" size={11} />
            </button>
          ) : null}
        </div>

        <div className="dr-list">
          {shown.map((w) => {
            const on = isOpen(w.id)
            const dd = daysTo(w.exam_date)
            return (
              <div className={'dr-ws' + (on ? ' on' : '') + (w.id === (cur && cur.id) ? ' cur' : '')} key={w.id}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ kind: 'ws', id: w.id, x: e.clientX, y: e.clientY })
                }}>
                <button className="dr-wsrow" onClick={() => toggleOpen(w.id)}>
                  <Icon n="folder" size={16} />
                  <span className="nm" title={w.name}>{w.name}</span>
                  <Icon n="chev" size={13} className="dr-chev" />
                </button>
                {on && view === 'tree' ? (
                  <div className="dr-sub">
                    {/* 展开只放会话 —— 学习/距考/分钟、科目标签这些删掉。
                        它们是「进去之后」才需要的信息，挂在侧栏里只会把列表撑乱。 */}
                    {sessionsOf(w.id).length ? (
                      <div className="dr-sess">
                        {sessionsOf(w.id).slice(0, 20).map((x) => (
                          <button key={x.id}
                            className={'dr-srow2' + (x.id === sid ? ' on' : '')
                              + (x.id === newId ? ' fresh' : '')}
                            onClick={() => openSession(x.id)}
                            onContextMenu={(e) => {
                              e.preventDefault()
                              /* 必须阻止冒泡：外层工作区行也挂了右键菜单，
                                 不拦住的话事件冒上去把会话菜单覆盖成工作区菜单 ——
                                 表现就是「右键只有工作区，没有会话」。 */
                              e.stopPropagation()
                              setMenu({ kind: 'sess', id: x.id, x: e.clientX, y: e.clientY })
                            }}
                            title={tstr(x.title) || '新会话'}>
                            <span className="nm">{tstr(x.title) || '新会话'}</span>
                            <em>{tstr(x.updated_at).slice(5, 16)}</em>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="dr-empty" style={{ paddingLeft: 10 }}>还没有对话</div>
                    )}

                    {/* 进入按钮：整行宽的安静入口，不是一颗悬浮的小按钮 */}
                    <button className="dr-enter2" onClick={() => { selectWs(w.id); onOpen(w.id) }}>
                      <span>进入工作区</span>
                      <Icon n="chev" size={12} />
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {looseCount ? (
            <div className={'dr-ws' + (isOpen('__loose') ? ' on' : '')}>
              <button className="dr-wsrow" onClick={() => toggleOpen('__loose')}>
                <Icon n="folder" size={16} />
                <span className="nm">未归类对话</span>
                <em className="dd">{looseCount}</em>
                <Icon n="chev" size={13} className="dr-chev" />
              </button>
              {isOpen('__loose') ? (
                <div className="dr-sub">
                  <div className="dr-meta"><span>还没挂到任何工作区的聊天</span></div>
                  <div className="dr-sess">
                    {sessionsOf('__loose').slice(0, 20).map((x) => (
                      <button key={x.id}
                        className={'dr-srow2' + (x.id === sid ? ' on' : '')}
                        onClick={() => openSession(x.id)}
                        title={tstr(x.title) || '新会话'}>
                        <span className="nm">{tstr(x.title) || '新会话'}</span>
                        <em>{tstr(x.updated_at).slice(5, 16)}</em>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {!shown.length && !looseCount
            ? <div className="dr-empty" style={{ padding: '8px 10px' }}>还没有工作区</div> : null}
        </div>

        <div className="dr-foot">
          <button className="dr-item" onClick={() => setMk(true)}>
            <Icon n="plus" size={17} /><span>新建工作区</span>
          </button>
          <div className="dr-user">
            <span className="ava">本</span>
            <div>
              <b>本机</b>
              <em>数据只存在这台机器</em>
            </div>
          </div>
        </div>
      </aside>

      <div className="dmain-wrap">
        {/* 对话区：直接复用 Chat —— 思考、工具调用、提问卡、轮次轨、
            命令面板（+ / @）、拖拽粘贴、状态条，全都是现成的。
            自绘一套就会跟工作区内的会话页长得不一样。 */}
        <Chat page="index" wsKey={BB?.ws?.id || ''} hideSessBar
          onTool={(c) => {
            const call: ToolCall = {
              tool: String(c.tool || ''),
              args: c.args || undefined,
              ms: c.ms || undefined,
              ok: c.ok !== false,
              summary: c.summary || undefined,
              error: c.error || undefined,
              need_confirm: !!c.need_confirm,
              ui: c.ui || null,
            }
            setTools((prev) => [...prev.filter((x: any) => !x.running), call])
            if (!manualOffRef.current) setTpOpen(true)
          }}
          onRun={(name) => {
            if (!name) return
            setTools((prev) => {
              if (prev.some((x: any) => x.tool === name && x.running)) return prev
              return [...prev, { tool: name, running: true, ok: true } as any]
            })
            if (!manualOffRef.current) setTpOpen(true)
          }}
        />

        {/* 右栏：AI 调工具时滑出，对话区自动左移 */}
        {tpOpen ? (
          <ToolPanel
            calls={tools}
            busy={tools.some((x: any) => x.running)}
            open={tpOpen}
            onClose={() => { setTpOpen(false); setTpManualOff(true); manualOffRef.current = true }}
          />
        ) : null}
      </div>

      {/* ---------------- 右键菜单 ---------------- */}
      {menu && menu.kind === 'ws' ? (
        <ContextMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          items={(() => {
            const w = list.find((x) => x.id === menu.id)
            if (!w) return []
            const isCur = cur && cur.id === w.id
            const it: MenuItem[] = [
              { label: '进入工作区', onClick: () => onOpen(w.id), disabled: !!isCur },
              { type: 'sep' },
              { label: '重命名', onClick: () => setRenaming({ kind: 'ws', id: w.id, v: w.name }) },
              { label: '归档（数据留着）', onClick: () => doArchive(w.id, true) },
              { label: '导出', hint: 'zip', onClick: () => doExport(w.id) },
              { type: 'sep' },
              {
                label: '删除工作区', danger: true,
                onClick: () => {
                  setDelPurge(false)
                  setDelWs({
                    id: w.id, name: w.name,
                    nSess: sessionsOf(w.id).length,
                  })
                },
              },
            ]
            return it
          })()}
        />
      ) : null}

      {menu && menu.kind === 'sess' ? (
        <ContextMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          items={(() => {
            const x = sessions.find((v) => v.id === menu.id)
            if (!x) return []
            return [
              { label: '打开', onClick: () => openSession(x.id) },
              { label: '重命名', onClick: () => setRenaming({ kind: 'sess', id: x.id, v: x.title || '' }) },
              { label: '分叉', hint: '复制一条', onClick: async () => {
                const r = await callTool<any>('session_fork', { sid: x.id })
                if (r.ok) {
                  const sl = await callTool<any>('session_list', { limit: 60 })
                  if (sl?.ok) {
                    const rows = ((sl.data as any)?.sessions || []).filter((y: any) => !y.archived)
                    mergeSessions(String(((BB as any)?.ws || {}).id || ''), rows)
                  }
                }
              } },
              { label: '归档', onClick: async () => {
                await callTool('session_archive', { sid: x.id })
                setSessions((ss) => ss.filter((y) => y.id !== x.id))
              } },
              { label: '复制链接', onClick: () => copySessLink(x.id) },
              { type: 'sep' },
              { label: '删除会话', danger: true,
                onClick: () => setDelSess({ id: x.id, title: x.title || '（没起名）' }) },
            ] as MenuItem[]
          })()}
        />
      ) : null}

      {/* 重命名：行内小弹框 */}
      {renaming ? (
        <div className="dm-mask" onClick={() => setRenaming(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <b className="cb-t">{renaming.kind === 'ws' ? '重命名工作区' : '重命名会话'}</b>
            <input
              className="dm-name" autoFocus value={renaming.v}
              onChange={(e) => setRenaming({ ...renaming, v: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') doRename() }}
            />
            <div className="cb-f">
              <button className="btn sm" onClick={() => setRenaming(null)}>算了</button>
              <button className="btn sm act" onClick={doRename}>改</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 删除工作区：二次确认 + 数据保留选择 */}
      {delWs ? (
        <ConfirmBox
          title={'删除「' + delWs.name + '」？'}
          body={'这个工作区下有 ' + delWs.nSess + ' 条会话。删了工作区，要不要连数据一起删？'}
          confirmText="删除" danger
          onCancel={() => { setDelWs(null); setDelPurge(false) }}
          onOk={doDeleteWs}
        >
          <div className={'cb-opt' + (delPurge ? '' : ' on')} onClick={() => setDelPurge(false)}>
            <i />
            <div>
              <b>只删工作区，数据留着</b>
              <span>会话、作答、笔记变成「未归属」，以后还能找回来</span>
            </div>
          </div>
          <div className={'cb-opt' + (delPurge ? ' on' : '')} onClick={() => setDelPurge(true)}>
            <i />
            <div>
              <b>连同数据一起删</b>
              <span>这个工作区下的会话、作答、笔记、画布、截图全部删掉，不可恢复</span>
            </div>
          </div>
        </ConfirmBox>
      ) : null}

      {/* 删除会话 */}
      {delSess ? (
        <ConfirmBox
          title={'删除会话「' + delSess.title + '」？'}
          body="这条会话的对话记录与过程轨迹会一起删掉，删了找不回来。"
          confirmText="删除" danger
          onCancel={() => setDelSess(null)}
          onOk={doDeleteSess}
        />
      ) : null}

      {showOb ? <Onboarding onDone={() => setShowOb(false)} /> : null}

      {mk ? (
        <div className="dm-mask" onClick={() => setMk(false)}>
          <div className="dm-modal" onClick={(e) => e.stopPropagation()}>
            <b className="dm-mt">新建工作区</b>
            <input
              className="dm-name"
              value={mkName}
              placeholder="起个名字，比如：2027 备考"
              autoFocus
              onChange={(e) => setMkName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createWs() }}
            />
            <div className="dm-mf">
              <button className="btn sm" onClick={() => setMk(false)}>算了</button>
              <button className="btn sm act" onClick={createWs} disabled={busy || !mkName.trim()}>
                {busy ? '建中…' : '建'}
              </button>
            </div>
            {err ? <div className="dm-mn" style={{ color: '#e06a5a' }}>{err}</div> : null}
            <div className="dm-mn">建完就进去。考什么、什么时候考、每天多久，进去之后助手会问。</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
