import { useEffect, useRef } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor, Position } from "monaco-editor";

export interface TableSchema {
  name: string;
  columns: string[];
}

export interface SQLMonacoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  onExecute?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  height?: string;
  hasError?: boolean;
  ariaLabel?: string;
  tables?: TableSchema[];
}

const sqlKeywords = [
  "SELECT", "FROM", "WHERE", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER",
  "ON", "AS", "AND", "OR", "NOT", "IN", "LIKE", "BETWEEN", "IS", "NULL",
  "ORDER", "BY", "ASC", "DESC", "GROUP", "HAVING", "LIMIT", "OFFSET",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE",
  "ALTER", "DROP", "INDEX", "DATABASE", "SCHEMA", "VIEW", "TRIGGER",
  "UNION", "ALL", "DISTINCT", "COUNT", "SUM", "AVG", "MAX", "MIN",
  "CASE", "WHEN", "THEN", "ELSE", "END", "CAST", "CONVERT",
  "EXISTS", "ANY", "SOME", "EXCEPT", "INTERSECT",
  "WITH", "RECURSIVE", "PARTITION", "OVER", "ROW_NUMBER",
  "RANK", "DENSE_RANK", "LEAD", "LAG", "FIRST_VALUE", "LAST_VALUE",
  "STRING_AGG", "ARRAY_AGG", "JSON_AGG",
];

const sqlFunctions = [
  "ABS", "ACOS", "ASIN", "ATAN", "ATAN2", "CEIL", "CEILING", "COS", "COT",
  "DEGREES", "EXP", "FLOOR", "LOG", "LOG10", "MOD", "PI", "POWER", "RADIANS",
  "RAND", "ROUND", "SIGN", "SIN", "SQRT", "TAN", "TRUNCATE",
  "ASCII", "CHAR", "CHAR_LENGTH", "CHARACTER_LENGTH", "CONCAT", "CONCAT_WS",
  "FIELD", "FIND_IN_SET", "FORMAT", "INSERT", "INSTR", "LCASE", "LEFT",
  "LENGTH", "LOCATE", "LOWER", "LPAD", "LTRIM", "MID", "POSITION", "REPEAT",
  "REPLACE", "REVERSE", "RIGHT", "RPAD", "RTRIM", "SPACE", "STRCMP", "SUBSTRING",
  "SUBSTRING_INDEX", "TRIM", "UCASE", "UPPER",
  "CURDATE", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURTIME",
  "DATE", "DATEDIFF", "DATE_ADD", "DATE_FORMAT", "DATE_SUB", "DAY", "DAYNAME",
  "DAYOFMONTH", "DAYOFWEEK", "DAYOFYEAR", "EXTRACT", "FROM_DAYS", "HOUR",
  "LAST_DAY", "LOCALTIME", "LOCALTIMESTAMP", "MAKEDATE", "MAKETIME", "MICROSECOND",
  "MINUTE", "MONTH", "MONTHNAME", "NOW", "PERIOD_ADD", "PERIOD_DIFF", "QUARTER",
  "SECOND", "SEC_TO_TIME", "STR_TO_DATE", "SUBDATE", "SUBTIME", "SYSDATE",
  "TIME", "TIME_FORMAT", "TIME_TO_SEC", "TIMEDIFF", "TIMESTAMP", "TIMESTAMPADD",
  "TIMESTAMPDIFF", "TO_DAYS", "WEEK", "WEEKDAY", "WEEKOFYEAR", "YEAR", "YEARWEEK",
  "COALESCE", "IFNULL", "ISNULL", "NULLIF",
  "IF", "CAST", "CONVERT",
];

let sqlLanguageSetup = false;

const tablesByModelUri = new Map<string, TableSchema[]>();

const ensureSqlLanguage = (monaco: Monaco) => {
  if (sqlLanguageSetup) {
    return;
  }

  try {
    monaco.languages.register({ id: "sql" });
  } catch {
    // already registered by another instance
  }

  monaco.languages.setMonarchTokensProvider("sql", {
    tokenizer: {
      root: [
        [/[ \t\r\n]+/, "white"],
        [/--.*$/, "comment"],
        [/\/\*[\s\S]*?\*\//, "comment"],
        [/[a-z_$][\w$]*/i, { cases: { "@keywords": "keyword", "@functions": "function", "@default": "identifier" } }],
        [/[0-9]+(\.[0-9]+)?/, "number"],
        [/["'][^"']*["']/, "string"],
        [/[<>=!]+/, "operator"],
        [/[;,]/, "delimiter"],
      ],
    },
    keywords: sqlKeywords,
    functions: sqlFunctions,
    operators: ["=", ">", "<", ">=", "<=", "<>", "!=", "<=>", "AND", "OR", "NOT", "IN", "LIKE", "BETWEEN", "IS", "NULL"],
    tokenPostfix: ".sql",
  });

  monaco.languages.setLanguageConfiguration("sql", {
    comments: { lineComment: "--", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.registerCompletionItemProvider("sql", {
    provideCompletionItems: (model: editor.ITextModel, position: Position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

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
      ];

      const tables = tablesByModelUri.get(model.uri.toString());
      if (tables) {
        tables.forEach((table) => {
          suggestions.push({
            label: table.name,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: table.name,
            range,
            documentation: `Table: ${table.name}`,
          });
          table.columns.forEach((column) => {
            suggestions.push(
              {
                label: `${table.name}.${column}`,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: `${table.name}.${column}`,
                range,
                documentation: `Column: ${column} from table ${table.name}`,
              },
              {
                label: column,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: column,
                range,
                documentation: `Column: ${column}`,
              },
            );
          });
        });
      }

      return { suggestions };
    },
    triggerCharacters: [".", " "],
  });

  sqlLanguageSetup = true;
};

const syncTablesForModel = (modelUri: string | null, tables?: TableSchema[]) => {
  if (!modelUri) {
    return;
  }

  if (tables) {
    tablesByModelUri.set(modelUri, tables);
  } else {
    tablesByModelUri.delete(modelUri);
  }
};

const syncEditorAriaInvalid = (
  editorInstance: editor.IStandaloneCodeEditor,
  hasError: boolean,
) => {
  const textarea = editorInstance.getContainerDomNode().querySelector("textarea");
  if (!textarea) {
    return;
  }

  if (hasError) {
    textarea.setAttribute("aria-invalid", "true");
  } else {
    textarea.removeAttribute("aria-invalid");
  }
};

const editorOptions: editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  lineNumbers: "on",
  roundedSelection: false,
  cursorStyle: "line",
  automaticLayout: true,
  tabSize: 2,
  wordWrap: "on",
  suggestOnTriggerCharacters: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  acceptSuggestionOnCommitCharacter: true,
  acceptSuggestionOnEnter: "on",
  snippetSuggestions: "top",
  scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
};

export function SQLMonacoEditor({
  value,
  onChange,
  onExecute,
  onBlur,
  disabled = false,
  height = "140px",
  hasError = false,
  ariaLabel = "SQL query",
  tables,
}: SQLMonacoEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelUriRef = useRef<string | null>(null);
  const onExecuteRef = useRef(onExecute);
  const onBlurRef = useRef(onBlur);

  useEffect(() => {
    onExecuteRef.current = onExecute;
  }, [onExecute]);

  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);

  useEffect(() => {
    syncTablesForModel(modelUriRef.current, tables);
  }, [tables]);

  useEffect(() => {
    return () => {
      syncTablesForModel(modelUriRef.current, undefined);
      modelUriRef.current = null;
    };
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions({ ariaLabel });
  }, [ariaLabel]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) {
      return;
    }
    syncEditorAriaInvalid(editorInstance, hasError);
  }, [hasError]);

  const handleEditorDidMount: OnMount = (editorInstance, monaco) => {
    editorRef.current = editorInstance;
    ensureSqlLanguage(monaco);

    const model = editorInstance.getModel();
    if (model) {
      modelUriRef.current = model.uri.toString();
      syncTablesForModel(modelUriRef.current, tables);
    }

    editorInstance.updateOptions({ readOnly: disabled });
    syncEditorAriaInvalid(editorInstance, hasError);

    editorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const isReadOnly = editorInstance.getOption(monaco.editor.EditorOption.readOnly);
      if (!isReadOnly) {
        onExecuteRef.current?.();
      }
    });

    editorInstance.onDidBlurEditorText(() => onBlurRef.current?.());
  };

  const borderColor = hasError
    ? "var(--notification-error, #d92d20)"
    : "var(--border-main)";

  return (
    <div
      aria-invalid={hasError || undefined}
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: "4px",
        overflow: "hidden",
        height,
      }}
    >
      <Editor
        height={height}
        language="sql"
        value={value}
        onChange={(val) => onChange?.(val ?? "")}
        onMount={handleEditorDidMount}
        theme="vs"
        options={{ ...editorOptions, readOnly: disabled, ariaLabel }}
      />
    </div>
  );
}
