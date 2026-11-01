import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'

/* 技能中心：看本机有哪些技能、各自什么时候用、正文长什么样。
 *
 * 「技能」和「插件」的区别（界面上也要说清，不然人会以为是同一件事）：
 *   技能 = 一份教模型怎么做的 Markdown（本机 skills/ 目录，扫出来的）
 *   插件 = 扩展能力的代码包（还没做）
 */

type Sk = {
  name: string
  description: string
  whenToUse: string
  userInvocable: boolean
  modelCan: boolean
  chars: number
  preview: string
}

export function Skills({ onGo }: { onGo?: (p: any) => void }) {
  const [items, setItems] = useState<Sk[]>([])
  const [dir, setDir] = useState('')
  const [sel, setSel] = useState<Sk | null>(null)
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/skills').then((r) => r.json()).then((d) => {
      setItems(d.items || [])
      setDir(d.dir || '')
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  async function openOne(s: Sk) {
    setSel(s)
    setBody('')
    const d = await fetch('/api/skills/' + encodeURIComponent(s.name))
      .then((r) => r.json()).catch(() => null)
    if (d?.ok) setBody(d.body || '')
  }

  return (
    <div className="skwrap">
      <div className="skhead">
        <div>
          <b>技能中心</b>
          <span className="skn">{items.length} 个</span>
        </div>
        <div className="skexp">
          技能 = 教模型怎么做的说明（本机 <code>skills/</code> 目录）
        </div>
      </div>

      {loading ? <div className="skempty">正在读本机技能…</div> : null}

      {!loading && !items.length ? (
        <div className="skempty">
          <p>本机还没有技能。</p>
          <p className="skhint">
            在项目里建 <code>skills/&lt;名字&gt;/SKILL.md</code>，写明
            <code>name</code> 和 <code>description</code> 就会出现在这里。
          </p>
          {dir ? <p className="skhint">目录：<code>{dir}</code></p> : null}
        </div>
      ) : null}

      {items.length ? (
        <div className="sksplit">
          <div className="sklist">
            {items.map((s) => (
              <button
                key={s.name}
                className={'skcard' + (sel?.name === s.name ? ' on' : '')}
                onClick={() => openOne(s)}
              >
                <div className="skcard-top">
                  <b>{s.name}</b>
                  {s.modelCan ? <em className="sktag">模型可用</em> : null}
                  {s.userInvocable ? <em className="sktag alt">可手动调用</em> : null}
                </div>
                <span className="skdesc">{s.description}</span>
                {s.whenToUse ? (
                  <span className="skwhen">什么时候用：{s.whenToUse}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="skbody">
            {sel ? (
              <>
                <div className="skbody-h">
                  <b>{sel.name}</b>
                  <em>{sel.chars} 字</em>
                </div>
                {body ? (
                  <pre className="skpre">{body}</pre>
                ) : (
                  <div className="skempty">正在读正文…</div>
                )}
              </>
            ) : (
              <div className="skempty">
                <div className="skempty-ic"><Icon n="stack" size={26} /></div>
                <p>点左边一项，看它的完整说明</p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
