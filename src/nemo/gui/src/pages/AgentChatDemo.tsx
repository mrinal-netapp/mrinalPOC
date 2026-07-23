import { type FC, useState } from 'react'
import {
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
} from '@assistant-ui/react'
import { makeStyles, tokens, Text } from '@fluentui/react-components'
import AgentThread from '../components/chat/AgentThread'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  threadContainer: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
})

const DEMO_SCENARIOS: Record<string, { text: string; toolCalls: { id: string; name: string; args: Record<string, unknown>; result: unknown }[] }> = {
  bar: {
    text: `I queried the top 8 categories by total view count from the \`utubeviews\` table. Here's a summary of the results:

**Key Insights:**
- **Music** dominates with 245K total views, nearly 25% more than the second-place category
- **Gaming** and **Education** are close contenders at 198K and 156K respectively
- The long tail (News, Travel) trails significantly — the top 3 categories account for roughly 55% of all views

The interactive chart above lets you toggle between bar and table views. You can hover over bars to see exact values.`,
    toolCalls: [{
      id: 'tc-bar-1',
      name: 'execute_query',
      args: { sql: 'SELECT category AS label, SUM(views) AS total_views FROM iceberg."proj1"."utubeviews" GROUP BY category ORDER BY total_views DESC LIMIT 8' },
      result: {
        columns: ['label', 'total_views'],
        rows: [
          ['Music', 245000],
          ['Gaming', 198000],
          ['Education', 156000],
          ['Comedy', 134000],
          ['Technology', 112000],
          ['Sports', 98000],
          ['News', 76000],
          ['Travel', 54000],
        ],
        rowCount: 8,
      },
    }],
  },
  pie: {
    text: `I ran a query to group files by extension in the \`docs\` dataset. Here's the breakdown:

| Extension | Count | Share |
|-----------|------:|------:|
| .md       |    65 | 57.5% |
| .txt      |    23 | 20.4% |
| .pdf      |    12 | 10.6% |
| .csv      |     8 |  7.1% |
| .json     |     5 |  4.4% |

The dataset is overwhelmingly Markdown files (**.md** at 57.5%). The pie chart above shows the proportional distribution. This makes sense for a documentation-focused dataset.`,
    toolCalls: [{
      id: 'tc-pie-1',
      name: 'execute_query',
      args: { sql: "SELECT extension AS type, COUNT(*) AS count FROM iceberg.\"proj1\".\"docs\" GROUP BY extension" },
      result: {
        columns: ['type', 'count'],
        rows: [
          ['.md', 65],
          ['.txt', 23],
          ['.pdf', 12],
          ['.csv', 8],
          ['.json', 5],
        ],
        rowCount: 5,
      },
    }],
  },
  line: {
    text: `I pulled the daily **views** and **subscribers** trend for the first two weeks of February 2026.

**Observations:**
1. Views show a clear **upward trend**, growing from ~12.4K on Feb 1 to ~22.1K on Feb 14 — a **78% increase**
2. Subscriber growth tracks views closely but at a smaller scale (340 → 520)
3. There's a notable **dip on Feb 3** (11.8K views) followed by a strong recovery
4. The steepest single-day jump was **Feb 13→14** (+1,600 views)

The line chart above plots both series. You can hover over data points for exact values, and toggle between chart and table view.`,
    toolCalls: [{
      id: 'tc-line-1',
      name: 'execute_query',
      args: { sql: "SELECT date, views, subscribers FROM iceberg.\"proj1\".\"utubeviews\" WHERE date >= '2026-02-01' ORDER BY date" },
      result: {
        columns: ['date', 'views', 'subscribers'],
        rows: [
          ['Feb 01', 12400, 340],
          ['Feb 02', 13100, 355],
          ['Feb 03', 11800, 348],
          ['Feb 04', 14200, 370],
          ['Feb 05', 15600, 395],
          ['Feb 06', 14800, 388],
          ['Feb 07', 16200, 410],
          ['Feb 08', 17500, 430],
          ['Feb 09', 16800, 425],
          ['Feb 10', 18200, 450],
          ['Feb 11', 19100, 472],
          ['Feb 12', 17900, 460],
          ['Feb 13', 20500, 498],
          ['Feb 14', 22100, 520],
        ],
        rowCount: 14,
      },
    }],
  },
  table: {
    text: `Here are all the tables available in the \`proj1\` schema:

- **docs** — 65 rows, 5 columns (2.3 MB) — documentation files metadata
- **sensitive** — 1,200 rows, 8 columns (15.7 MB) — contains PII/sensitive data markers
- **utubecateries** — 340 rows, 4 columns (1.1 MB) — YouTube category reference data
- **utubeviews** — 45,600 rows, 12 columns (128.4 MB) — YouTube video view metrics
- **wikipedia** — 89,200 rows, 6 columns (456.2 MB) — Wikipedia article extracts

The largest table is \`wikipedia\` at 456 MB. To explore any table, you can ask me to run \`SELECT * FROM iceberg."proj1"."<table>" LIMIT 100\` or describe its columns.`,
    toolCalls: [{
      id: 'tc-table-1',
      name: 'execute_query',
      args: { sql: 'SHOW ALL TABLES' },
      result: {
        columns: ['database', 'schema', 'table_name', 'column_count', 'row_count', 'estimated_size'],
        rows: [
          ['iceberg', 'proj1', 'docs', 5, 65, '2.3 MB'],
          ['iceberg', 'proj1', 'sensitive', 8, 1200, '15.7 MB'],
          ['iceberg', 'proj1', 'utubecateries', 4, 340, '1.1 MB'],
          ['iceberg', 'proj1', 'utubeviews', 12, 45600, '128.4 MB'],
          ['iceberg', 'proj1', 'wikipedia', 6, 89200, '456.2 MB'],
        ],
        rowCount: 5,
      },
    }],
  },
  multi: {
    text: `I ran two queries to give you a complete picture:

**Query 1 — Category Breakdown:**
Music leads with 1,240 videos, followed by Gaming (980) and Education (760). Comedy rounds out the top 4 at 540.

**Query 2 — Top 5 Videos by Views:**
The most-viewed video is *"How to Learn Python in 2026"* from CodeAcademy with **2.45M views** and a 5.1% like ratio. Interestingly, *"AI Explained Simply"* has the highest like-to-view ratio at 6.7%, suggesting strong audience engagement despite fewer total views.

Both result sets are rendered as interactive charts/tables above. You can toggle between chart and table view on each one independently.`,
    toolCalls: [
      {
        id: 'tc-multi-1',
        name: 'execute_query',
        args: { sql: "SELECT category, COUNT(*) AS count FROM iceberg.\"proj1\".\"utubeviews\" GROUP BY category" },
        result: {
          columns: ['category', 'count'],
          rows: [
            ['Music', 1240],
            ['Gaming', 980],
            ['Education', 760],
            ['Comedy', 540],
          ],
          rowCount: 4,
        },
      },
      {
        id: 'tc-multi-2',
        name: 'execute_query',
        args: { sql: "SELECT title, channel, views, likes FROM iceberg.\"proj1\".\"utubeviews\" ORDER BY views DESC LIMIT 5" },
        result: {
          columns: ['title', 'channel', 'views', 'likes'],
          rows: [
            ['How to Learn Python in 2026', 'CodeAcademy', 2450000, 124000],
            ['Top 10 Gaming Moments', 'GameClips', 1980000, 98500],
            ['Jazz Relaxation Mix', 'ChillBeats', 1560000, 67800],
            ['AI Explained Simply', 'TechSimple', 1340000, 89200],
            ['World Cup Highlights', 'SportsCentral', 1120000, 56700],
          ],
          rowCount: 5,
        },
      },
    ],
  },
}

function createDemoAdapter(): ChatModelAdapter {
  let scenarioIndex = 0
  const scenarioKeys = Object.keys(DEMO_SCENARIOS)

  return {
    async *run({ messages }) {
      const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1)
      const userText = lastUserMessage?.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('') || ''

      const key = userText.trim().toLowerCase()
      const scenario = DEMO_SCENARIOS[key] || DEMO_SCENARIOS[scenarioKeys[scenarioIndex % scenarioKeys.length]]
      if (!DEMO_SCENARIOS[key]) scenarioIndex++

      await new Promise((r) => setTimeout(r, 300))

      let text = ''
      const toolCalls = new Map<string, { toolName: string; argsText: string }>()
      const toolResults = new Map<string, unknown>()

      for (const tc of scenario.toolCalls) {
        toolCalls.set(tc.id, {
          toolName: tc.name,
          argsText: JSON.stringify(tc.args),
        })

        const result: ChatModelRunResult = {
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...[...toolCalls.entries()].map(([id, t]) => ({
              type: 'tool-call' as const,
              toolCallId: id,
              toolName: t.toolName,
              argsText: t.argsText,
              args: JSON.parse(t.argsText),
              ...(toolResults.has(id) ? { result: toolResults.get(id) } : {}),
            })),
          ],
        }
        yield result

        await new Promise((r) => setTimeout(r, 500))

        toolResults.set(tc.id, tc.result)

        const result2: ChatModelRunResult = {
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...[...toolCalls.entries()].map(([id, t]) => ({
              type: 'tool-call' as const,
              toolCallId: id,
              toolName: t.toolName,
              argsText: t.argsText,
              args: JSON.parse(t.argsText),
              ...(toolResults.has(id) ? { result: toolResults.get(id) } : {}),
            })),
          ],
        }
        yield result2
      }

      const words = scenario.text.split(/(?<=\s)/)
      for (const word of words) {
        text += word
        await new Promise((r) => setTimeout(r, 20))

        const result: ChatModelRunResult = {
          content: [
            { type: 'text' as const, text },
            ...[...toolCalls.entries()].map(([id, tc]) => ({
              type: 'tool-call' as const,
              toolCallId: id,
              toolName: tc.toolName,
              argsText: tc.argsText,
              args: JSON.parse(tc.argsText),
              ...(toolResults.has(id) ? { result: toolResults.get(id) } : {}),
            })),
          ],
        }
        yield result
      }
    },
  }
}

const DemoThread: FC = () => {
  const [adapter] = useState(() => createDemoAdapter())
  const runtime = useLocalRuntime(adapter)
  return <AgentThread runtime={runtime} />
}

export default function AgentChatDemo() {
  const styles = useStyles()

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text size={400} weight="semibold">
          Agent Chat Demo — SQLResultToolUI Test
        </Text>
        <br />
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
          Type one of: <strong>bar</strong>, <strong>pie</strong>, <strong>line</strong>, <strong>table</strong>, <strong>multi</strong> — or anything else to cycle through scenarios
        </Text>
      </div>
      <div className={styles.threadContainer}>
        <DemoThread />
      </div>
    </div>
  )
}
