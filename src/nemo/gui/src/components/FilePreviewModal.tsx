import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  makeStyles,
  tokens,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  Button,
  Spinner,
  Text,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import {
  Dismiss24Regular,
  Open16Regular,
  ArrowDownload16Regular,
} from '@fluentui/react-icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Editor from '@monaco-editor/react'

type FileCategory = 'markdown' | 'image' | 'text' | 'pdf' | 'unknown'

const MARKDOWN_EXTS = new Set(['md', 'mdx'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
const PDF_EXTS = new Set(['pdf'])
const TEXT_EXTS = new Set([
  'txt', 'csv', 'log', 'json', 'yaml', 'yml', 'xml', 'html', 'css',
  'py', 'js', 'ts', 'jsx', 'tsx', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'sql', 'sh', 'bash', 'zsh', 'toml', 'ini', 'cfg', 'env', 'conf',
  'dockerfile', 'makefile', 'gitignore', 'proto', 'graphql', 'r', 'rb',
  'php', 'swift', 'kt', 'scala', 'lua', 'pl', 'ex', 'exs', 'erl',
])

const EXT_TO_LANGUAGE: Record<string, string> = {
  py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript',
  tsx: 'typescript', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
  h: 'c', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html',
  css: 'css', toml: 'toml', ini: 'ini', dockerfile: 'dockerfile',
  makefile: 'makefile', graphql: 'graphql', r: 'r', rb: 'ruby',
  php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala', lua: 'lua',
  pl: 'perl', proto: 'protobuf', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  csv: 'plaintext', log: 'plaintext', txt: 'plaintext', cfg: 'ini',
  env: 'shell', conf: 'ini', gitignore: 'plaintext',
}

function getExtension(fileName: string): string {
  const base = fileName.split('/').pop() || fileName
  const dotIdx = base.lastIndexOf('.')
  if (dotIdx < 0) return base.toLowerCase()
  return base.slice(dotIdx + 1).toLowerCase()
}

function getFileCategory(ext: string): FileCategory {
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'unknown'
}

function getMonacoLanguage(ext: string): string {
  return EXT_TO_LANGUAGE[ext] || 'plaintext'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getBaseUrl(fileUrl: string): string {
  const lastSlash = fileUrl.lastIndexOf('/')
  return lastSlash >= 0 ? fileUrl.slice(0, lastSlash + 1) : fileUrl
}

function isAbsoluteUrl(href: string): boolean {
  return /^[a-z][a-z0-9+\-.]*:/i.test(href) || href.startsWith('//')
}

function resolveRelativeUrl(href: string, baseUrl: string): string {
  if (!href || isAbsoluteUrl(href) || href.startsWith('#') || href.startsWith('data:')) {
    return href
  }
  try {
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

interface FilePreviewModalProps {
  url: string
  fileName: string
  onClose: () => void
}

const useStyles = makeStyles({
  surface: {
    width: '900px',
    height: '80vh',
    minWidth: '400px',
    minHeight: '300px',
    maxWidth: '95vw',
    maxHeight: '95vh',
    padding: 0,
    resize: 'both',
    overflow: 'hidden',
  },
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  titleText: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  content: {
    padding: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: '48px',
  },
  markdownContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 24px',
    '& p': { marginTop: 0, marginBottom: '8px' },
    '& p:last-child': { marginBottom: 0 },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '12px',
      borderRadius: '8px',
      overflowX: 'auto',
      fontSize: '13px',
    },
    '& code': { fontFamily: 'monospace', fontSize: '13px' },
    '& :not(pre) > code': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '2px 6px',
      borderRadius: '4px',
    },
    '& table': {
      borderCollapse: 'collapse',
      width: '100%',
      marginBottom: '8px',
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke1}`,
      padding: '6px 10px',
      textAlign: 'left',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground4,
      fontWeight: 600,
    },
    '& ul, & ol': { paddingLeft: '20px', marginTop: 0, marginBottom: '8px' },
    '& blockquote': {
      borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
      marginLeft: 0,
      paddingLeft: '12px',
      color: tokens.colorNeutralForeground3,
    },
    '& img': {
      maxWidth: '100%',
    },
    '& h1, & h2, & h3, & h4, & h5, & h6': {
      marginTop: '16px',
      marginBottom: '8px',
    },
  },
  imageContainer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'auto',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground3,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain',
    borderRadius: '4px',
  },
  editorContainer: {
    flex: 1,
    minHeight: '300px',
    position: 'relative',
  },
  pdfContainer: {
    flex: 1,
    minHeight: '300px',
    height: 0,
    overflow: 'hidden',
  },
  fallbackContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: '16px',
    padding: '48px',
  },
  errorContainer: {
    padding: '16px',
  },
})

export default function FilePreviewModal({ url, fileName, onClose }: FilePreviewModalProps) {
  const styles = useStyles()
  const ext = getExtension(fileName)
  const category = getFileCategory(ext)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [blobSize, setBlobSize] = useState<number>(0)
  const [blob, setBlob] = useState<Blob | null>(null)

  const baseUrl = useMemo(() => getBaseUrl(url), [url])

  const markdownComponents = useMemo(() => ({
    img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      <img {...props} src={src ? resolveRelativeUrl(src, baseUrl) : src} alt={alt || ''} />
    ),
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        {...props}
        href={href ? resolveRelativeUrl(href, baseUrl) : href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
  }), [baseUrl])

  useEffect(() => {
    let revoked = false
    const controller = new AbortController()

    const fetchFile = async () => {
      setLoading(true)
      setError(null)
      try {
        const resp = await fetch(url, { signal: controller.signal })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)

        const fetchedBlob = await resp.blob()
        setBlobSize(fetchedBlob.size)
        setBlob(fetchedBlob)

        if (category === 'markdown' || category === 'text') {
          const text = await fetchedBlob.text()
          setTextContent(text)
        } else if (category === 'image' || category === 'pdf') {
          const objectUrl = URL.createObjectURL(fetchedBlob)
          setBlobUrl(objectUrl)
        }
      } catch (e: unknown) {
        if (!revoked) {
          setError(e instanceof Error ? e.message : 'Failed to load file')
        }
      } finally {
        if (!revoked) setLoading(false)
      }
    }

    fetchFile()

    return () => {
      revoked = true
      controller.abort()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
    // Only run on mount (url/category changes mean a new modal instance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const handleDownload = useCallback(() => {
    if (!blob) return
    const downloadUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = fileName.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(downloadUrl)
  }, [blob, fileName])

  const renderContent = () => {
    if (loading) {
      return (
        <div className={styles.loadingContainer}>
          <Spinner size="medium" label="Loading file..." />
        </div>
      )
    }

    if (error) {
      return (
        <div className={styles.errorContainer}>
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
          <div style={{ padding: '16px', textAlign: 'center' }}>
            <Button
              icon={<Open16Regular />}
              as="a"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              appearance="primary"
            >
              Open in new tab
            </Button>
          </div>
        </div>
      )
    }

    switch (category) {
      case 'markdown':
        return (
          <div className={styles.markdownContainer}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {textContent || ''}
            </ReactMarkdown>
          </div>
        )

      case 'image':
        return (
          <div className={styles.imageContainer}>
            <img src={blobUrl || url} alt={fileName} className={styles.image} />
          </div>
        )

      case 'text':
        return (
          <div className={styles.editorContainer}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
              <Editor
                height="100%"
                language={getMonacoLanguage(ext)}
                value={textContent || ''}
                theme="vs-dark"
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  fontSize: 13,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>
        )

      case 'pdf':
        return (
          <div className={styles.pdfContainer}>
            <iframe
              src={blobUrl || url}
              title={fileName}
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          </div>
        )

      default:
        return (
          <div className={styles.fallbackContainer}>
            <Text size={400} weight="semibold">
              {fileName.split('/').pop() || fileName}
            </Text>
            <Text size={300} style={{ color: tokens.colorNeutralForeground3 }}>
              {blobSize > 0 ? formatBytes(blobSize) : 'Preview not available for this file type'}
            </Text>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button
                icon={<ArrowDownload16Regular />}
                appearance="primary"
                onClick={handleDownload}
                disabled={!blob}
              >
                Download
              </Button>
              <Button
                icon={<Open16Regular />}
                as="a"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                appearance="secondary"
              >
                Open in new tab
              </Button>
            </div>
          </div>
        )
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogSurface className={styles.surface}>
        <DialogBody style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
          <DialogTitle className={styles.title}>
            <Text weight="semibold" className={styles.titleText} title={fileName}>
              {fileName.split('/').pop() || fileName}
            </Text>
            {!loading && blobSize > 0 && (
              <Text size={200} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>
                {formatBytes(blobSize)}
              </Text>
            )}
            <Button
              icon={<ArrowDownload16Regular />}
              size="small"
              appearance="subtle"
              onClick={handleDownload}
              disabled={!blob}
              title="Download"
            />
            <Button
              icon={<Open16Regular />}
              size="small"
              appearance="subtle"
              as="a"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in new tab"
            />
            <Button
              icon={<Dismiss24Regular />}
              size="small"
              appearance="subtle"
              onClick={onClose}
              title="Close"
            />
          </DialogTitle>
          <DialogContent className={styles.content}>
            {renderContent()}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
