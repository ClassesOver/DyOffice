/**
 * Multi-turn Office analysis scenarios over the synthetic `sales` schema
 * (seed.sql). Each check compares the model's answer or inserted table with
 * ground truth computed directly in PostgreSQL, never with model text.
 */
export interface Turn { prompt: string }
export interface TrialEvidence {
  /** final assistant text per turn */
  answers: string[]
  /** tool calls in order, with name, input and whether it errored */
  calls: { turn: number; name: string; input: Record<string, unknown>; isError: boolean }[]
  /** table content applied through insert_data_result */
  inserted: { rows: readonly (readonly string[])[] }[]
}
export interface Check { name: string; pass: boolean; detail: string }
export interface Scenario {
  id: string
  title: string
  format: 'docx' | 'xlsx' | 'pptx'
  turns: Turn[]
  /** ground truth queries run with full privileges before the trials */
  truth: Record<string, string>
  grade(evidence: TrialEvidence, truth: Record<string, Record<string, unknown>[]>): Check[]
}

const numbersIn = (text: string): number[] =>
  [...text.replaceAll(/(?<=\d),(?=\d{3})/g, '').matchAll(/-?\d+(?:\.\d+)?\s*(万|亿)?/g)].map(match => {
    const value = Number.parseFloat(match[0])
    return match[1] === '亿' ? value * 1e8 : match[1] === '万' ? value * 1e4 : value
  })

/** The answer states the value, allowing rounding to 0.5% (e.g. 1012.3万 for 10,123,456.78). */
export function mentions(text: string, expected: number, tolerance = 0.005): boolean {
  return numbersIn(text).some(value => Math.abs(value - expected) <= Math.max(0.01, Math.abs(expected) * tolerance))
}

const num = (value: unknown) => Number(value)
/** Some line of the text (or row of a table) carries both the label and the value. */
const pairedLine = (lines: readonly string[], label: (line: string) => boolean, expected: number, tolerance?: number) =>
  lines.some(line => label(line) && mentions(line, expected, tolerance))
const linesOf = (text: string) => text.split(/\r?\n/)
const CN_DIGITS = ['零', '一', '二', '三', '四']
const quarterLabel = (q: number) => (line: string) =>
  new RegExp(`Q${q}(?!\\d)|第?[${q}${CN_DIGITS[q]}]季度`, 'i').test(line)
/**
 * Month label in a row: a year-month (2026-01, 2026-01-01, 2026/1, 2026年1月; amounts such as 2299305.30 are not dates), or, since the
 * scenario fixes one year, a month alone (1月, January, or a leading month-number cell).
 */
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const monthLabel = (month: string) => {
  const [year, value] = month.split('-').map(Number) as [number, number]
  return (line: string) => {
    const dated = [...line.matchAll(/(?<![\d.])((?:19|20)\d{2})\s*[-/年]\s*(\d{1,2})(?!\d)/g)]
    if (dated.length) return dated.some(match => Number(match[1]) === year && Number(match[2]) === value)
    const name = MONTH_NAMES[value - 1]!
    return new RegExp(`(?<![\\d.])0?${value}\\s*月`).test(line) || new RegExp(`\\b(?:${name}|${name.slice(0, 3)})\\b`, 'i').test(line) || Number(line.trim().split(/\s+/)[0]) === value
  }
}
const queried = (evidence: TrialEvidence, turn?: number) =>
  evidence.calls.filter(call => call.name === 'sources_query' && !call.isError && (turn === undefined || call.turn === turn))
const sqlOf = (evidence: TrialEvidence, turn?: number) => queried(evidence, turn).map(call => String(call.input.sql ?? '')).join('\n')
const check = (name: string, pass: boolean, detail = ''): Check => ({ name, pass, detail })

export const SCENARIOS: Scenario[] = [
  {
    id: 'discover-and-aggregate',
    title: '发现表结构后按季度汇总已付金额',
    format: 'docx',
    turns: [
      { prompt: '销售数据源里有哪些表？' },
      { prompt: '2026 年每个季度的已付金额合计分别是多少？请逐季列出。' },
    ],
    truth: {
      quarters: `SELECT extract(quarter FROM order_date)::int AS q, sum(paid_amount) AS paid FROM sales.orders WHERE order_date >= '2026-01-01' AND order_date < '2027-01-01' GROUP BY 1 ORDER BY 1`,
    },
    grade(evidence, truth) {
      const quarters = truth.quarters!
      return [
        check('turn 1 names both tables', /orders/.test(evidence.answers[0] ?? '') && /order_items/.test(evidence.answers[0] ?? '')),
        check('turn 2 aggregates in SQL', /sum\s*\(/i.test(sqlOf(evidence, 1)) && /group\s+by/i.test(sqlOf(evidence, 1)), sqlOf(evidence, 1)),
        ...quarters.map(row => check(`Q${row.q} total stated`, pairedLine(linesOf(evidence.answers[1] ?? ''), quarterLabel(num(row.q)), num(row.paid)), `expected Q${row.q} ${row.paid} on one line`)),
      ]
    },
  },
  {
    id: 'detail-request-truncated',
    title: '明细请求被截断时改用数据库端聚合',
    format: 'docx',
    turns: [
      { prompt: '把 2026 年的所有订单明细查出来，然后告诉我其中华东区的已付金额总额和订单数。' },
    ],
    truth: {
      east: `SELECT sum(paid_amount) AS paid, count(*) AS orders, count(*) FILTER (WHERE status = 'paid') AS paid_orders FROM sales.orders WHERE region = '华东' AND order_date >= '2026-01-01' AND order_date < '2027-01-01'`,
    },
    grade(evidence, truth) {
      const east = truth.east![0]!
      const answer = evidence.answers[0] ?? ''
      return [
        check('total computed in SQL', /sum\s*\(/i.test(sqlOf(evidence)), sqlOf(evidence)),
        check('east paid total stated', mentions(answer, num(east.paid)), `expected ${east.paid}`),
        // "订单数" is ambiguous between all orders and paid orders; either reading is accepted.
        check('east order count stated', mentions(answer, num(east.orders), 0) || mentions(answer, num(east.paid_orders), 0), `expected ${east.orders} (all) or ${east.paid_orders} (paid)`),
      ]
    },
  },
  {
    id: 'insert-channel-table',
    title: '把渠道汇总作为表格插入 Word',
    format: 'docx',
    turns: [
      { prompt: '统计 2026 年各渠道的已付订单数和已付金额，把结果作为表格插入到文档里。' },
    ],
    truth: {
      channels: `SELECT channel, count(*) AS orders, sum(paid_amount) AS paid FROM sales.orders WHERE status = 'paid' AND order_date >= '2026-01-01' AND order_date < '2027-01-01' GROUP BY channel ORDER BY channel`,
    },
    grade(evidence, truth) {
      const table = evidence.inserted.at(-1)?.rows ?? []
      const cells = table.flat().join(' ')
      return [
        check('insert_data_result succeeded', evidence.calls.some(call => call.name === 'insert_data_result' && !call.isError)),
        check('no values retyped through text tools', !evidence.calls.some(call => call.name === 'insert_content')),
        ...truth.channels!.map(row => check(`${row.channel} row inserted`, table.some(line => line.includes(String(row.channel)) && mentions(line.join(' '), num(row.paid)) && mentions(line.join(' '), num(row.orders), 0)), `expected ${row.channel} ${row.orders} ${row.paid}`)),
        check('provenance notes present', /Source: sales/.test(cells)),
      ]
    },
  },
  {
    id: 'join-ranking-follow-up',
    title: '跨表排名并在追问中沿用口径',
    format: 'docx',
    turns: [
      { prompt: '按明细的数量乘以单价计算销售额，只算已付订单。销售额最高的 3 个商品类别是哪些？各是多少？' },
      { prompt: '同样口径，只看华南区呢？' },
    ],
    truth: {
      all: `SELECT i.category, sum(i.quantity * i.unit_price) AS revenue FROM sales.order_items i JOIN sales.orders o USING (order_id) WHERE o.status = 'paid' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
      south: `SELECT i.category, sum(i.quantity * i.unit_price) AS revenue FROM sales.order_items i JOIN sales.orders o USING (order_id) WHERE o.status = 'paid' AND o.region = '华南' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
    },
    grade(evidence, truth) {
      const ranked = (text: string, rows: Record<string, unknown>[]) => {
        const positions = rows.map(row => text.indexOf(String(row.category)))
        return positions.every(p => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]!)
      }
      return [
        check('turn 1 joins in SQL', /join/i.test(sqlOf(evidence, 0)), sqlOf(evidence, 0)),
        check('turn 1 top 3 in order', ranked(evidence.answers[0] ?? '', truth.all!), truth.all!.map(r => r.category).join(',')),
        ...truth.all!.map(row => check(`turn 1 ${row.category} revenue`, pairedLine(linesOf(evidence.answers[0] ?? ''), line => line.includes(String(row.category)), num(row.revenue)), `expected ${row.category} ${row.revenue} on one line`)),
        check('turn 2 keeps the paid filter and adds region', /paid/i.test(sqlOf(evidence, 1)) && /华南/.test(sqlOf(evidence, 1)), sqlOf(evidence, 1)),
        check('turn 2 top 3 in order', ranked(evidence.answers[1] ?? '', truth.south!), truth.south!.map(r => r.category).join(',')),
      ]
    },
  },
  {
    id: 'excel-monthly-insert',
    title: '把月度趋势写入 Excel 单元格',
    format: 'xlsx',
    turns: [
      { prompt: '把 2026 年 1 到 6 月每个月的已付金额写到表格里，从当前选中的单元格开始。' },
    ],
    truth: {
      months: `SELECT to_char(order_date, 'YYYY-MM') AS month, sum(paid_amount) AS paid FROM sales.orders WHERE order_date >= '2026-01-01' AND order_date < '2026-07-01' GROUP BY 1 ORDER BY 1`,
    },
    grade(evidence, truth) {
      const table = evidence.inserted.at(-1)?.rows ?? []
      return [
        check('insert_data_result succeeded', evidence.calls.some(call => call.name === 'insert_data_result' && !call.isError)),
        ...truth.months!.map(row => check(`${row.month} inserted`, pairedLine(table.map(line => line.join(' ')), monthLabel(String(row.month)), num(row.paid)), `expected ${row.month} ${row.paid} in one row`)),
      ]
    },
  },
]
