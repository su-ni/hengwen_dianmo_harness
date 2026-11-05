import { useEffect, useState } from 'react'
import { useTool } from '../lib/useTool'
import type { Base } from '../lib/api'
import { Verdict, Card, Li, Mini, Empty, Skel, clsColor, Kpi } from '../components/V6'
import { hm } from '../lib/fmt'

/* 统计页 v6：按 design-v6.html:424-495 重画。
   上排四个 38px 大数字（讲次 / 在记的词 / 作答 / 连续打卡），下面一条结论条 ——
   那行字由这四个数按规则判出来，不是模型写的，所以结论条上要写明「由下面的数字推出来」。
   再往下是两行两栏：左栏装讲题与讲次，右栏装打卡与词记忆。
   每个数字都能用一条 curl 打回同一行，页面不自己算第二遍。 */

type Ov = {
  lessons: { done: number; total: number }
  words: { in_memory: number; due_today: number; total: number; boxes: Record<string, number> }
  bank: { name: string; total: number }
  answers: { answered: number; right: number; wrong: number; accuracy: number | null }
  exam_papers: number
  point_cards: { name: string; count: number }[]
  time: { total: number; today: number; by_kind: Record<string, number> }
}
type Cal = {
  days: Record<string, { d: string; n: number; ok: number; words: number }>
  streak: number; checked_today: boolean; count: number; note: string
}
type ExStats = {
  total: number; verified: number; votes_up: number; votes_down: number
  revisions: number; by_model: number; by_source: { source: string; n: number; v: number }[]
}
type ExCov = {
  total: number; speakable: number; speakable_rate: number; avg_confidence: number
  by_verdict: Record<string, number>
  by_source: Record<string, Record<string, number>>
  note?: string
}
/* 熟练度（第 11 章 D33–D37）：跨科目的掌握度。
   为什么要在统计页而不是单独开一页：它跟"讲次/词/作答"是同一类东西 ——
   都是"这台机器上到底学成什么样"。
   单开一页会变成"又一个没人点的页面"。 */
type MaRow = {
  item_id: string; kind: string | null; score: number | null
  reason: string | null; subject: string | null
}
type MaStat = {
  total: number; avg_score: number; samples: number; due: number
  by_kind: Record<string, number>
  buckets: number[]          // 五档：0-20% / 20-40% / 40-60% / 60-80% / 80-100%
  weak: MaRow[]
  top: { item_id: string; kind: string | null; score: number | null }[]
}
type SubRow = {
  id: string; name: string; score: number | null; cls: string
  lessons_done: number; lessons_total: number
}

// 盒 → 复习间隔。写在记忆算法里的常量，没有第四盒以外的盒就照实显示盒号。
const BOX_DAY: Record<string, string> = { '1': '今天', '2': '2 天', '3': '4 天', '4': '7 天' }
// 科目色统一走 V6.clsColor —— 服务端的 cls 是 coral/teal/violet 这类颜色词。
const colOf = (cls: string) => clsColor(cls)

export function Stats({ base }: { base: Base }) {
  const ov = useTool<Ov>('stats_overview')
  const cal = useTool<Cal>('checkin_calendar')
  const subs = useTool<{ subjects: SubRow[] }>('list_subjects')
  const exs = useTool<ExStats>('explain_stats')
  // 熟练度：跨科目，所以不跟随当前科目
  const ma = useTool<MaStat>('mastery_list')
  // 判断模型状态：这个数是模型判的还是规则估的，得让人知道
  const jd = useTool<{
    trained: boolean; src: string; samples: number
    min_samples: number; ready: boolean
  }>('judge_status')
  /* 可讲率要全量扫题库（实测 1.1 秒）—— 不能让它堵住上面那排数字，
     所以晚一步再挂。扫之前那一行摆占位，不假装它不存在。 */
  const [covReady, setCovReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setCovReady(true), 40); return () => clearTimeout(t) }, [])
  const cov = useTool<ExCov>('explain_coverage', {}, { skip: !covReady })
  const d = ov.data
  const c = cal.data

  const lessons = d?.lessons ?? { done: 0, total: 0 }
  const words = d?.words ?? { in_memory: 0, due_today: 0, total: 0, boxes: {} }
  /* 任何「几个数相加」的地方都先过它：没回来算 0，不把 NaN 漏到界面上 */
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  /* 真题可判分题数：以前这里写死 995，实际题库比它多/少都对不上。
     现在读 stats_overview 回的真数（题源自报的 total），查不到就显示「—」。 */
  const examN = (d as any)?.exam_bank_total ?? 0
  const books: { name: string; count: number }[] = (d as any)?.vocab_books ?? []
  const booksN = (d as any)?.vocab_books_total ?? 0
  const ans = d?.answers ?? { answered: 0, right: 0, wrong: 0, accuracy: null }
  const boxes = words.boxes || {}
  const boxMax = Math.max(1, ...Object.values(boxes).map(Number))
  const cardTotal = (d?.point_cards || []).reduce((a, x) => a + (x.count || 0), 0)
  const timeTotal = d?.time?.total ?? 0
  /* 百分比一律过一道 clamp：分母为 0 时上面已经给 0，但接口半路回来时
     done/total 里可能混进 undefined，算出来是 NaN —— React 会把 NaN
     原样写进 style，控制台一条警告，进度条宽度悄悄失效。
     宁可停在 0，也不要一条看起来很短的条其实是「没算出来」。 */
  const pct = (a: number, b: number) => {
    const v = b ? (a / b) * 100 : 0
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0
  }
  const lessonPct = pct(lessons.done, lessons.total)
  const wordPct = pct(words.in_memory, words.total)

  // 最近 70 天，按真实记录填，没记录就是空格子 —— 不做「连续 99 天」的美化图
  const days: string[] = []
  for (let i = 69; i >= 0; i--) {
    const x = new Date(); x.setDate(x.getDate() - i)
    days.push(x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2))
  }
  const lvl = (n: number) => (n >= 60 ? 'b' : n >= 30 ? 'a' : '')

  /* 一句话结论：哪一环最拖后腿。四条规则写在这儿，触发几条就说几条，没有就直说没有。 */
  const weak: string[] = []
  if (lessons.total && lessons.done / lessons.total < 0.1) weak.push('讲次几乎没动')
  if (ans.answered >= 5 && (ans.accuracy ?? 0) < 50) weak.push('正确率偏低')
  if (!c?.count) weak.push('还没有打卡记录')
  if (!timeTotal) weak.push('没有真实计时')

  const rows = (subs.data?.subjects || []).filter((s) => s.score)
  const speakPct = cov.data ? Math.round((cov.data.speakable_rate || 0) * 1000) / 10 : null

  return (
    <>
      <div className="kpi-mn">
        {/* 前三格点了能去干活那页。第四格「连续打卡」没有单独一页，
            给不出真落脚点 —— 那就别做成能点的样子。 */}
        <Kpi to="courses">
          <div className="k">讲次</div>
          <div className="v">{lessons.done}<small>/ {lessons.total}</small></div>
          <div className="m"><i style={{ width: lessonPct + '%' }} /></div>
          <div className="s">{lessons.total
            ? `走完 ${lessons.done} 讲 · 剩 ${Math.max(0, lessons.total - lessons.done)} 讲`
            : '课程库是空的'}</div>
        </Kpi>
        <Kpi to="vocab">
          <div className="k">在记的词</div>
          <div className="v">{words.in_memory}<small>/ {words.total ?? '—'}</small></div>
          <div className="m"><i style={{ width: wordPct + '%' }} /></div>
          <div className="s">{words.due_today ? `今天到期 ${words.due_today} 个` : '今天没有到期的'}</div>
        </Kpi>
        <Kpi to="practice">
          <div className="k">作答</div>
          <div className="v">{ans.answered}<small>题</small></div>
          <div className="s">
            {ans.answered
              /* accuracy 可能是 null（一道都没判过）。直接 {ans.accuracy}% 会渲染成
                 「null%」，React 还会为它报一条 NaN 警告 —— 没算出来就明说没算出来。 */
              ? <>对 {ans.right} · 错 {ans.wrong} · 正确率{' '}
                <b style={{ color: (ans.accuracy ?? 0) < 50 ? 'var(--bad)' : 'var(--ok)' }}>
                  {ans.accuracy == null ? '—' : ans.accuracy + '%'}
                </b></>
              : '还没做过题'}
          </div>
        </Kpi>
        <div>
          <div className="k">连续打卡</div>
          <div className="v">{c?.streak ?? 0}<small>天</small></div>
          <div className="s">{c?.checked_today ? '今天已经打过卡' : '今天还没打卡'}</div>
        </div>
      </div>

      {weak.length ? (
        <Verdict tone="warn" title={`最该补的：${weak.join('、')}`} />
      ) : (
        <Verdict tone="good" title="四项都在走，保持住。" />
      )}

      <div className="twocol-mn">
        <Card title="讲题记录">
          {!exs.data?.total ? (
            <Empty title="还没有讲题记录">
              在练习页点「讲清这题」，讲过的每一版都留在这里。
            </Empty>
          ) : (
            <>
              <div className="mini-mn">
                <Mini k="讲过" v={exs.data.total} unit="道" />
                <Mini k="依据全过" v={exs.data.verified} unit="道"
                  dim={!exs.data.verified} />
                <Mini k="说讲得对" v={exs.data.votes_up} unit="次" dim={!exs.data.votes_up} />
                <Mini k="说讲错了" v={exs.data.votes_down} unit="次" dim={!exs.data.votes_down} />
              </div>
              <div className="note-mn bare">
                {exs.data.votes_up + exs.data.votes_down > 0
                  ? `被评价过的 ${exs.data.votes_up + exs.data.votes_down} 次里，讲对率 ${Math.round((exs.data.votes_up / (exs.data.votes_up + exs.data.votes_down)) * 100)}%。`
                  : '还没人点过「讲得对 / 讲错了」。'}
                {exs.data.revisions ? `　一共留底 ${exs.data.revisions} 版。` : ''}
              </div>
            </>
          )}

          {/* 可讲率：全量扫过一遍才敢写百分比，扫之前先摆占位 */}
          {!covReady || cov.loading ? (
            /* 扫题库要一秒多，这段时间不能只写一行灰字 —— 摆个骨架占住位置，
               顺便把「在扫、没坏」这件事说清楚。 */
            <>
              <div className="skel-mn" style={{ height: 11, width: '88%', marginTop: 14 }} />
              <Skel kind="row" n={3} />
            </>
          ) : cov.data ? (
            <>
              <div className="note-mn" style={{ marginTop: 12 }}>
                能讲的 <b style={{ color: 'var(--tx2)' }}>{cov.data.speakable}</b> / {cov.data.total} 题，
                可讲率 <b style={{ color: 'var(--tx2)' }}>{speakPct}%</b>。
              </div>
              {/* 顺序由「能不能讲」定，不能靠后端字典序 ——
                  按对象键遍历会把「有据可依」埋到最下面，读的人第一眼看到的是最没用的那档。
                  条形颜色也照这条链走：能讲是绿的，讲不全黄，讲不了灰的。 */}
              {[
                ['有据可依', 'var(--ok)'],
                ['依据部分成立', 'var(--warn)'],
                ['无解析 · 可定位', 'var(--line2)'],
                ['只能靠背', 'var(--line2)'],
              ].filter(([k]) => (cov.data!.by_verdict || {})[k] != null).map(([k, c]) => {
                const n = cov.data!.by_verdict[k] || 0
                const p = cov.data!.total ? (n / cov.data!.total) * 100 : 0
                return (
                  <Li key={k} label={k}
                    /* 百分比原样给：38/2972 = 1.3% 压在四舍五入之后会变成「0%」，
                       条形图也跟着消失，看起来像「没有这一档」。 */
                    pct={p}
                    color={c as string}
                    value={`${n} 题${p < 1 ? ` · ${p.toFixed(1)}%` : ''}`} />
                )
              })}
            </>
          ) : (
            <div className="note-mn" style={{ marginTop: 12 }}>可讲率没算出来。</div>
          )}
        </Card>

        <Card title="打卡" note={`最近 70 天 · ${c?.count ?? 0} 天有记录`}>
          <div className="cal-mn">
            {days.map((x) => {
              const n = c?.days?.[x]?.n ?? 0
              return <i key={x} className={lvl(n)} title={x + (n ? ' · ' + n + ' 次' : ' · 没记录')} />
            })}
          </div>
          <div className="note-mn">
            近 70 天里有 {c?.count ?? 0} 天学过。
          </div>
        </Card>
      </div>

      <div className="twocol-mn">
        <Card title="讲次 · 按科目">
          {rows.length ? (
            rows.map((s) => (
              <Li key={s.id} label={s.name}
                pct={s.lessons_total ? (s.lessons_done / s.lessons_total) * 100 : 0}
                color={colOf(s.cls)}
                value={`${s.lessons_done} / ${s.lessons_total}`} />
            ))
          ) : (
            <Empty title="还没有带分值的科目">
              科目有了分值，讲次进度才按分值额度拆开算。
            </Empty>
          )}
          <div className="note-mn">
            不计分的课排在最后，条是灰的 —— 它不占额度，也不算落后。
          </div>
        </Card>

        <Card title="词记忆分布" note="盒越大，复习间隔越长">
          {Object.keys(boxes).sort().length ? (
            Object.keys(boxes).sort().map((b) => (
              <Li key={b} label={`盒 ${b}${BOX_DAY[b] ? ' · ' + BOX_DAY[b] : ''}`}
                pct={(Number(boxes[b]) / boxMax) * 100}
                color={Number(boxes[b]) ? 'var(--act)' : 'var(--line2)'}
                value={`${boxes[b]} 词`} />
            ))
          ) : (
            <Empty title="还没有词进记忆">
              背几张卡，这里就会有盒分布。
            </Empty>
          )}
          <div className="note-mn">
            {timeTotal
              ? `累计投入 ${hm(timeTotal)}，今天 ${d?.time?.today ?? 0} 分钟。`
              : '还没有计时记录。'}
          </div>
        </Card>


        {/* ---- 熟练度（第 11 章 D33–D37）----
            它回答的是「到底会不会」，跟上面的「讲了几讲 / 背了多少词」是两个维度：
            前者是投入，后者是产出。只看投入会让人以为学了很多，
            而熟练度才是"考场上能不能写出来"的那个数。 */}
        <Card title="熟练度" note={ma.data ? `${ma.data.total} 项 · 训练样本 ${ma.data.samples} 条` : '跨科目'}>
          {ma.loading && !ma.data ? <Skel n={3} /> : null}
          {ma.err ? <Empty title={`熟练度读不出来：${ma.err}`} /> : null}
          {ma.data && ma.data.total === 0 ? (
            <Empty title="还没有作答记录 —— 做几道题或背几个词，这里就会有数" />
          ) : null}
          {ma.data && ma.data.total > 0 ? (
            <>
              {/* 判断模型状态：不假装用了模型 */}
              <div className="ma-src">
                <span className={jd.data?.trained ? 'on' : ''}>
                  {jd.loading ? '读模型状态…' : jd.data?.trained
                    ? '自建模型判分' : '规则估分（模型还没训）'}
                </span>
                <span>
                  {jd.data ? `样本 ${jd.data.samples} / ${jd.data.min_samples}` : ''}
                </span>
              </div>

              {/* 平均分 + 到期数：两个一眼能读的数 */}
              <div className="ma-top">
                <div className="ma-big">
                  <b>{Math.round((ma.data.avg_score ?? 0) * 100)}</b>
                  <span>平均掌握度</span>
                </div>
                <div className="ma-big">
                  <b className={ma.data.due > 0 ? 'hot' : ''}>{ma.data.due}</b>
                  <span>今天该复习</span>
                </div>
              </div>

              {/* 五档分布：比一个平均分有用 —— 平均 60 分可能是"都不错"也可能是"一半会一半不会" */}
              <div className="ma-dist">
                {ma.data.buckets.map((n, i) => {
                  const pct = ma.data!.total ? (n / ma.data!.total) * 100 : 0
                  const label = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'][i]
                  return (
                    <div className="ma-bar" key={i} title={`${label}：${n} 项`}>
                      <i style={{ height: `${Math.max(4, pct)}%`, background: i < 2 ? 'var(--bad)' : i < 3 ? 'var(--act)' : 'var(--ok)' }} />
                      <span>{n}</span>
                    </div>
                  )
                })}
              </div>

              {/* 最薄的几条：界面要直接告诉人"该补哪里"，不是让他自己找 */}
              {ma.data.weak.length ? (
                <div className="ma-weak">
                  <div className="ma-h">最不牢的</div>
                  {ma.data.weak.slice(0, 5).map((w) => (
                    <div className="ma-row" key={w.item_id}>
                      <span className="ma-n">{w.item_id}</span>
                      <span className="ma-s">{Math.round((w.score ?? 0) * 100)}</span>
                      <span className="ma-r">{w.reason}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ma-ok">没有明显薄的项</div>
              )}
            </>
          ) : null}
        </Card>
      </div>

      {/* 四个数相加，任何一个没回来就是 NaN 串到屏幕上。
         /api/base 还没到（d 为空）时 words 有兜底，但 d.bank / examN / cardTotal
         各有各的就绪时机 —— 所以相加前统一过一道 num()，缺的按 0 算，
         显示层再决定要不要写「—」。宁可在界面上少一个数，不要一个 NaN。 */}
      <div className="note-mn">
        本机家底合计 <b style={{ color: 'var(--tx2)' }}>{num(words.total) + num(d?.bank?.total) + num(examN) + num(cardTotal)}</b> 条
        （词 {words.total} + 语法 {d?.bank?.total ?? 0} + 真题 {examN || '—'} + 考点卡 {cardTotal}）。
        {booksN > words.total ? `　另有 ${books.length - 1} 本词书共 ${booksN} 词。` : ''}
      </div>
    </>
  )
}
