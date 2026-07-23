import { useRef } from 'react'
import Editor, { Monaco, OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { makeStyles, tokens } from '@fluentui/react-components'

const useStyles = makeStyles({
  editorContainer: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    minHeight: '200px',
  },
})

export interface TableSchema {
  name: string
  columns: string[]
}

export interface SQLMonacoEditorProps {
  value: string
  onChange?: (value: string) => void
  onExecute?: () => void
  placeholder?: string
  disabled?: boolean
  height?: string
  theme?: 'light' | 'dark' | 'vs-dark' | 'vs'
  tables?: TableSchema[] // Optional table schemas for autocomplete
}

// SQL keywords and functions for autocomplete
const sqlKeywords = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
  'ORDER', 'BY', 'ASC', 'DESC', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE',
  'ALTER', 'DROP', 'INDEX', 'DATABASE', 'SCHEMA', 'VIEW', 'TRIGGER',
  'UNION', 'ALL', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'CONVERT',
  'EXISTS', 'ANY', 'SOME', 'EXCEPT', 'INTERSECT',
  'WITH', 'RECURSIVE', 'AS', 'PARTITION', 'OVER', 'ROW_NUMBER',
  'RANK', 'DENSE_RANK', 'LEAD', 'LAG', 'FIRST_VALUE', 'LAST_VALUE',
  'STRING_AGG', 'ARRAY_AGG', 'JSON_AGG',
]

const sqlFunctions = [
  'ABS', 'ACOS', 'ASIN', 'ATAN', 'ATAN2', 'CEIL', 'CEILING', 'COS', 'COT',
  'DEGREES', 'EXP', 'FLOOR', 'LOG', 'LOG10', 'MOD', 'PI', 'POWER', 'RADIANS',
  'RAND', 'ROUND', 'SIGN', 'SIN', 'SQRT', 'TAN', 'TRUNCATE',
  'ASCII', 'CHAR', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'CONCAT', 'CONCAT_WS',
  'FIELD', 'FIND_IN_SET', 'FORMAT', 'INSERT', 'INSTR', 'LCASE', 'LEFT',
  'LENGTH', 'LOCATE', 'LOWER', 'LPAD', 'LTRIM', 'MID', 'POSITION', 'REPEAT',
  'REPLACE', 'REVERSE', 'RIGHT', 'RPAD', 'RTRIM', 'SPACE', 'STRCMP', 'SUBSTRING',
  'SUBSTRING_INDEX', 'TRIM', 'UCASE', 'UPPER',
  'CURDATE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURTIME',
  'DATE', 'DATEDIFF', 'DATE_ADD', 'DATE_FORMAT', 'DATE_SUB', 'DAY', 'DAYNAME',
  'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR', 'EXTRACT', 'FROM_DAYS', 'HOUR',
  'LAST_DAY', 'LOCALTIME', 'LOCALTIMESTAMP', 'MAKEDATE', 'MAKETIME', 'MICROSECOND',
  'MINUTE', 'MONTH', 'MONTHNAME', 'NOW', 'PERIOD_ADD', 'PERIOD_DIFF', 'QUARTER',
  'SECOND', 'SEC_TO_TIME', 'STR_TO_DATE', 'SUBDATE', 'SUBTIME', 'SYSDATE',
  'TIME', 'TIME_FORMAT', 'TIME_TO_SEC', 'TIMEDIFF', 'TIMESTAMP', 'TIMESTAMPADD',
  'TIMESTAMPDIFF', 'TO_DAYS', 'WEEK', 'WEEKDAY', 'WEEKOFYEAR', 'YEAR', 'YEARWEEK',
  'COALESCE', 'IFNULL', 'ISNULL', 'NULLIF',
  'IF', 'CAST', 'CONVERT',
]

// Track if SQL language is already registered to avoid duplicate registration
let sqlLanguageRegistered = false

const setupSQL = (monaco: Monaco, tables?: TableSchema[]) => {
  // Register SQL language only if not already registered
  if (!sqlLanguageRegistered) {
    try {
      monaco.languages.register({ id: 'sql' })
      sqlLanguageRegistered = true
    } catch (error) {
      // Language might already be registered by another instance
      // This is fine, we can continue
      console.debug('SQL language already registered')
    }
  }

  // Set SQL tokens
  monaco.languages.setMonarchTokensProvider('sql', {
    tokenizer: {
      root: [
        [/[ \t\r\n]+/, 'white'],
        [/--.*$/, 'comment'],
        [/\/\*[\s\S]*?\*\//, 'comment'],
        [/[a-z_$][\w$]*/i, {
          cases: {
            '@keywords': 'keyword',
            '@functions': 'function',
            '@default': 'identifier',
          },
        }],
        [/[0-9]+(\.[0-9]+)?/, 'number'],
        [/["'][^"']*["']/, 'string'],
        [/[<>=!]+/, 'operator'],
        [/[;,]/, 'delimiter'],
      ],
    },
    keywords: sqlKeywords,
    functions: sqlFunctions,
    operators: [
      '=', '>', '<', '>=', '<=', '<>', '!=', '<=>',
      'AND', 'OR', 'NOT', 'IN', 'LIKE', 'BETWEEN', 'IS', 'NULL',
    ],
    tokenPostfix: '.sql',
  })

  // Set SQL language configuration
  monaco.languages.setLanguageConfiguration('sql', {
    comments: {
      lineComment: '--',
      blockComment: ['/*', '*/'],
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  })

  // Register completion provider
  monaco.languages.registerCompletionItemProvider('sql', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }

      const suggestions = [
        ...sqlKeywords.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          range,
          documentation: `SQL keyword: ${keyword}`,
        })),
        ...sqlFunctions.map((func) => ({
          label: func,
          kind: monaco.languages.CompletionItemKind.Function,
          insertText: `${func}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          documentation: `SQL function: ${func}`,
        })),
      ]

      // Add table suggestions if available
      if (tables) {
        tables.forEach((table) => {
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            range,
            documentation: `Table: ${table.name}`,
          })

          // Add column suggestions
          table.columns.forEach((column) => {
            suggestions.push({
              label: `${table.name}.${column}`,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: `${table.name}.${column}`,
              range,
              documentation: `Column: ${column} from table ${table.name}`,
            })
            suggestions.push({
              label: column,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: column,
              range,
              documentation: `Column: ${column}`,
            })
          })
        })
      }

      return { suggestions }
    },
    triggerCharacters: ['.', ' '],
  })
}

export function SQLMonacoEditor({
  value,
  onChange,
  onExecute,
  placeholder: _placeholder, // Monaco Editor doesn't support placeholder natively
  disabled = false,
  height = '200px',
  theme = 'vs',
  tables,
}: SQLMonacoEditorProps) {
  const styles = useStyles()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor

    // Setup SQL language support with table schemas
    setupSQL(monaco, tables)

    // Add keyboard shortcut for execute (Cmd/Ctrl + Enter)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      if (onExecute && !disabled) {
        onExecute()
      }
    })

    // Add keyboard shortcut for format (Shift + Alt + F)
    editor.addCommand(
      monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
      () => {
        editor.getAction('editor.action.formatDocument')?.run()
      }
    )

    // Set editor options
    editor.updateOptions({
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 14,
      lineNumbers: 'on',
      roundedSelection: false,
      cursorStyle: 'line',
      automaticLayout: true,
      tabSize: 2,
      wordWrap: 'on',
      readOnly: disabled,
    })
  }

  // Note: Theme can be enhanced to detect system theme or use Fluent UI theme
  // For now, using the 'vs' theme passed as prop

  return (
    <div className={styles.editorContainer} style={height === '100%' ? { height: '100%' } : { height }}>
      <Editor
        height={height === '100%' ? '100%' : height}
        language="sql"
        value={value}
        onChange={(val) => onChange?.(val || '')}
        onMount={handleEditorDidMount}
        theme={theme}
        options={{
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 14,
          lineNumbers: 'on',
          roundedSelection: false,
          cursorStyle: 'line',
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          readOnly: disabled,
          suggestOnTriggerCharacters: true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: false,
          },
          acceptSuggestionOnCommitCharacter: true,
          acceptSuggestionOnEnter: 'on',
          snippetSuggestions: 'top',
        }}
      />
    </div>
  )
}

