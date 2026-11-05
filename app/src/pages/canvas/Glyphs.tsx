/* ============================================================
   canvas/Glyphs.tsx —— 从 Canvas.tsx 抽出来的纯展示组件

   为什么抽：Canvas.tsx 主体 2553 行，其中这几个是**完全自包含**的
   小组件（只用传入的 props + 外部 import，不碰任何编辑器状态）。
   放回去只是让「找一行逻辑」多翻 150 行。

   零行为改动：代码逐字搬过来，只补 import。
   ============================================================ */
import { Icon } from '../../components/Icon'
import { MindNode as MindNodeView } from './MindNode'
import type { LayoutMode } from './autolayout'


/* 版面按钮的图标：三种布局各画一个示意图。用内联 svg 而不是 Icon ——
   Icon 里没有「布局」这一类，往那套通用图标里塞三个只在这里用的形状不划算。 */
function LayoutGlyph({ mode }: { mode: LayoutMode }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' as const }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="cvglyph">
      {mode === 'mind' ? (
        <g {...p}>
          <path d="M5 8 H8 M8 4.5 V11.5 M8 4.5 H11 M8 11.5 H11" />
          <rect x="2" y="6.4" width="3" height="3.2" rx=".9" />
          <rect x="11" y="2.9" width="3" height="3.2" rx=".9" />
          <rect x="11" y="9.9" width="3" height="3.2" rx=".9" />
        </g>
      ) : mode === 'treeV' ? (
        <g {...p}>
          <path d="M8 5 V8 M4.5 8 H11.5 M4.5 8 V11 M11.5 8 V11" />
          <rect x="6.4" y="2" width="3.2" height="3" rx=".9" />
          <rect x="2.9" y="11" width="3.2" height="3" rx=".9" />
          <rect x="9.9" y="11" width="3.2" height="3" rx=".9" />
        </g>
      ) : (
        <g {...p}>
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="2.6" r="1.2" />
          <circle cx="13.4" cy="8" r="1.2" />
          <circle cx="8" cy="13.4" r="1.2" />
          <path d="M8 6.5 V3.8 M9.5 8 H12.2 M8 9.5 V12.2" />
        </g>
      )}
    </svg>
  )
}

const NODE_TYPES = { mind: MindNodeView }

/* ── 导图连线 ──────────────────────────────────────────────────────
   为什么要自己画：React Flow 内置的 'default' 边只认「右出左进」，
   左支（向左长的那些）的线会从源节点的右腰出发、绕一大圈才回到目标节点的右腰，
   看起来像横穿节点的一条横杠 —— 试过 targetHandle/sourceHandle 也不行，
   它算贝塞尔的锚点方向是写死的。

   这里按 side 自己算控制点：
   - 右支：源右腰 → 目标左腰，控制点各自水平外推半个间距
   - 左支：源左腰 → 目标右腰，方向整个镜像
   - 竖直布局：源下沿 → 目标上沿，控制点垂直外推
   这样两种方向的弧线是对称的，也才像导图的主枝。 */
function MindEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd }: any) {
  /* 方向只看 sourcePosition —— 它是「这条边从哪个口出去」，最可靠。
     targetPosition 也要看，但只用来区分竖树（bottom）。 */
  const horiz = sourcePosition === 'left' || sourcePosition === 'right'
  let d: string
  if (sourcePosition === 'bottom') {
    // 竖树 / 放射：从父的下沿垂下去，再进子的上沿
    const dy = Math.abs(targetY - sourceY)
    const my = sourceY + Math.max(16, dy * 0.5)
    d = `M${sourceX},${sourceY} C${sourceX},${my} ${targetX},${my} ${targetX},${targetY}`
  } else if (sourcePosition === 'left') {
    // 左支：从父的左腰往左伸，再水平拐进子的右腰
    const dx = Math.abs(sourceX - targetX)
    const mx = sourceX - Math.max(22, dx * 0.5)
    d = `M${sourceX},${sourceY} C${mx},${sourceY} ${mx},${targetY} ${targetX},${targetY}`
  } else if (horiz) {
    // 右支：镜像
    const dx = Math.abs(targetX - sourceX)
    const mx = sourceX + Math.max(22, dx * 0.5)
    d = `M${sourceX},${sourceY} C${mx},${sourceY} ${mx},${targetY} ${targetX},${targetY}`
  } else {
    // 兜底：直线（放射布局里会走到这儿）
    d = `M${sourceX},${sourceY} L${targetX},${targetY}`
  }
  return <path id={id} className="react-flow__edge-path" d={d} style={style} markerEnd={markerEnd} fill="none" />
}
const EDGE_TYPES = { mind: MindEdge }

/* 弹层外壳：三个弹层共用一套（标题 + 可滚内容 + 底部操作条），
   避免每个弹层各写一份 padding 和关闭按钮，间距一定不齐。 */
function Modal({ title, sub, onClose, foot, children, wide }: {
  title: string; sub?: string; onClose: () => void; foot?: React.ReactNode; children: React.ReactNode; wide?: boolean
}) {
  return (
    <div className="mdl" onClick={onClose}>
      <div className={'mdl-box' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
        <header className="mdl-hd">
          <div className="mdl-tt">
            <b>{title}</b>
            {sub ? <span>{sub}</span> : null}
          </div>
          <button className="mdl-x" title="关掉" onClick={onClose}><Icon n="x" size={16} /></button>
        </header>
        <div className="mdl-bd">{children}</div>
        {foot ? <footer className="mdl-ft">{foot}</footer> : null}
      </div>
    </div>
  )
}

/* 画布卡片的缩略图 —— 画成一张真的小思维导图，不是一列带点的文字。
   原来那样（一行一个分支、左边一个点）在卡上根本看不出结构：
   一屏六张卡，六列小字，谁是谁的子节点全靠缩进猜。
   现在按导图的画法来：主题居中，一级分支左右分开，曲线接过去，
   层级靠字色深浅分。数据还是后端那棵 shape（t 文字 / c 子 / col 色），不编。 */
/* Markdown 预览树：把后端 note_from_md 返回的真树画出来（不是前端自己猜层级） */
function TreePreview({ node, d = 0 }: { node: any; d?: number }) {
  if (!node) return null
  const kids = (node.children || []) as any[]
  return (
    <div className={'tp-n d' + Math.min(d, 4)}>
      <span className="tp-t" title={String(node.text || '')}>{node.text || '（空）'}</span>
      {kids.map((c) => <TreePreview key={c.id} node={c} d={d + 1} />)}
    </div>
  )
}

export { LayoutGlyph, MindEdge, Modal, TreePreview, NODE_TYPES, EDGE_TYPES }