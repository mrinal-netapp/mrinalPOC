import { useMemo, useState, type FC } from 'react'
import Editor from '@monaco-editor/react'
import { makeStyles, tokens, Button, Text } from '@fluentui/react-components'
import { deepParseJsonStringValues } from '../traceRenderUtils'

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    marginBottom: '8px',
  },
  title: {
    color: tokens.colorNeutralForeground3,
    flex: 1,
    fontSize: '12px',
  },
  editorWrap: {
    borderRadius: '6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
})

const MAX_EDITOR_HEIGHT = 560
const MIN_EDITOR_HEIGHT = 200
const LINE_HEIGHT = 19

export interface AttributesJsonViewProps {
  attrs: Record<string, unknown>
}

/**
 * Pretty-printed span attributes with Monaco JSON syntax highlighting.
 * Optional “unwrap” mode parses JSON-looking string fields so nested objects are visible.
 */
export const AttributesJsonView: FC<AttributesJsonViewProps> = ({ attrs }) => {
  const styles = useStyles()
  const [unwrapNested, setUnwrapNested] = useState(true)

  const displayText = useMemo(() => {
    try {
      const obj = unwrapNested ? deepParseJsonStringValues(attrs) : attrs
      return JSON.stringify(obj, null, 2)
    } catch {
      return JSON.stringify(attrs, null, 2)
    }
  }, [attrs, unwrapNested])

  const lineCount = displayText.split('\n').length
  const editorHeight = Math.min(
    MAX_EDITOR_HEIGHT,
    Math.max(MIN_EDITOR_HEIGHT, lineCount * LINE_HEIGHT + 24),
  )

  const copyAll = () => {
    void navigator.clipboard.writeText(displayText)
  }

  return (
    <>
      <div className={styles.toolbar}>
        <Text className={styles.title}>Attributes (JSON)</Text>
        <Button
          size="small"
          appearance={unwrapNested ? 'primary' : 'subtle'}
          onClick={() => setUnwrapNested((u) => !u)}
          title="When on, string values that contain JSON are parsed so you see nested objects instead of one escaped line"
        >
          {unwrapNested ? 'Nested JSON parsed' : 'Parse nested JSON strings'}
        </Button>
        <Button size="small" appearance="subtle" onClick={copyAll}>
          Copy all
        </Button>
      </div>
      <div className={styles.editorWrap}>
        <Editor
          height={`${editorHeight}px`}
          language="json"
          value={displayText}
          theme="vs"
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            lineNumbers: 'on',
            wordWrap: 'on',
            fontSize: 12,
            folding: true,
            automaticLayout: true,
            tabSize: 2,
            renderLineHighlight: 'line',
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
          }}
        />
      </div>
    </>
  )
}
