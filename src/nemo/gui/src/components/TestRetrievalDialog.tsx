import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Button,
  Dropdown,
  Option,
  Textarea,
  Input,
  Label,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Badge,
  makeStyles,
  tokens,
  Tooltip,
} from '@fluentui/react-components'
import { Search24Regular, Dismiss24Regular, ChevronDown20Regular, ChevronUp20Regular } from '@fluentui/react-icons'
import { knowledgeBaseApi, KnowledgeBase, KBSearchRequest, KBSearchResponse, KBSearchResult, RerankerType } from '../services/api'

// Reranker configuration
const RERANKER_OPTIONS: { id: RerankerType; name: string; description: string }[] = [
  { id: 'rrf', name: 'RRF (Default)', description: 'Reciprocal Rank Fusion - fast, no dependencies' },
  { id: 'cross_encoder', name: 'Cross Encoder', description: 'High quality reranking using local model' },
  { id: 'linear', name: 'Linear Combination', description: 'Weighted mix of vector and FTS scores' },
]

const useStyles = makeStyles({
  dialogSurface: {
    maxWidth: '950px',
    width: '90vw',
    maxHeight: '85vh',
  },
  formSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    marginBottom: '16px',
  },
  formRow: {
    display: 'flex',
    gap: '16px',
    alignItems: 'flex-end',
  },
  formField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
  },
  parametersRow: {
    display: 'flex',
    gap: '24px',
    alignItems: 'flex-end',
    flexWrap: 'wrap' as const,
  },
  parameterField: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '140px',
  },
  resultsSection: {
    marginTop: '16px',
  },
  resultsHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: '4px',
  },
  latencyBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  tableContainer: {
    maxHeight: '350px',
    overflowY: 'auto',
    overflowX: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '4px',
  },
  table: {
    width: '100%',
    minWidth: '700px',
    tableLayout: 'fixed' as const,
  },
  expandedText: {
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '13px',
    lineHeight: '1.5',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  // Column-specific styles
  colExpand: {
    width: '44px',
    minWidth: '44px',
    maxWidth: '44px',
  },
  colScore: {
    width: '80px',
    minWidth: '80px',
    maxWidth: '80px',
  },
  colText: {
    width: 'auto',
    minWidth: '200px',
  },
  colSource: {
    width: '150px',
    minWidth: '150px',
    maxWidth: '150px',
  },
  colChunk: {
    width: '70px',
    minWidth: '70px',
    maxWidth: '70px',
    textAlign: 'center' as const,
  },
  // Cell content styles
  cellContent: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  truncatedText: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    lineHeight: '1.4',
  },
  expandButton: {
    minWidth: 'auto',
    padding: '2px',
  },
  scoreCell: {
    display: 'flex',
    alignItems: 'center',
  },
  noResults: {
    padding: '24px',
    textAlign: 'center' as const,
    color: tokens.colorNeutralForeground3,
  },
  errorDetails: {
    marginTop: '8px',
    padding: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '4px',
    fontFamily: 'monospace',
    fontSize: '12px',
    maxHeight: '100px',
    overflowY: 'auto',
  },
})

interface TestRetrievalDialogProps {
  open: boolean
  onClose: () => void
  knowledgeBases: KnowledgeBase[]
  projectId: string
}

interface SearchError {
  type: string
  message: string
  details?: string
  suggestion?: string
}

export function TestRetrievalDialog({
  open,
  onClose,
  knowledgeBases,
  projectId,
}: TestRetrievalDialogProps) {
  const styles = useStyles()

  // Form state
  const [selectedKbId, setSelectedKbId] = useState<string>('')
  const [query, setQuery] = useState<string>('')
  const [topK, setTopK] = useState<number>(10)
  const [minScore, setMinScore] = useState<number>(0)
  
  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false)
  const [rerankerType, setRerankerType] = useState<RerankerType>('rrf')
  const [nprobe, setNprobe] = useState<number | undefined>(undefined)
  const [refineFactor, setRefineFactor] = useState<number | undefined>(undefined)
  const [linearWeight, setLinearWeight] = useState<number>(0.7)

  // Search state
  const [loading, setLoading] = useState<boolean>(false)
  const [searchResponse, setSearchResponse] = useState<KBSearchResponse | null>(null)
  const [error, setError] = useState<SearchError | null>(null)

  // Expanded rows for viewing full text
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Filter to only show KBs with status 'ready'
  const availableKBs = useMemo(() => {
    return knowledgeBases.filter((kb) => kb.status === 'ready')
  }, [knowledgeBases])

  // Get selected KB name for dropdown display
  const selectedKbName = useMemo(() => {
    const kb = availableKBs.find((kb) => kb.id === selectedKbId)
    return kb ? kb.name : ''
  }, [availableKBs, selectedKbId])

  const handleSearch = async () => {
    if (!selectedKbId || !query.trim()) {
      setError({
        type: 'Validation Error',
        message: 'Please select a knowledge base and enter a query.',
        suggestion: 'Select a knowledge base from the dropdown and enter your search query.',
      })
      return
    }

    setLoading(true)
    setError(null)
    setSearchResponse(null)
    setExpandedRows(new Set())

    try {
      const request: KBSearchRequest = {
        query: query.trim(),
        topK,
        minScore,
        distanceMetric: 'cosine',
      }
      
      // Add advanced options to the request if they are set
      // Note: These are not in the typed interface but will be passed through
      const advancedRequest = request as any
      if (rerankerType && rerankerType !== 'rrf') {
        advancedRequest.rerankerType = rerankerType
        if (rerankerType === 'linear') {
          advancedRequest.rerankerOptions = { weight: linearWeight }
        }
      }
      if (nprobe) {
        advancedRequest.nprobe = nprobe
      }
      if (refineFactor) {
        advancedRequest.refineFactor = refineFactor
      }

      const response = await knowledgeBaseApi.search(projectId, selectedKbId, advancedRequest)
      setSearchResponse(response)
    } catch (err: any) {
      // Parse error response for structured display
      const parsedError = parseError(err)
      setError(parsedError)
    } finally {
      setLoading(false)
    }
  }

  const parseError = (err: any): SearchError => {
    // Handle axios error response
    if (err.response) {
      const status = err.response.status
      const data = err.response.data

      if (status === 400) {
        return {
          type: 'Bad Request',
          message: data?.error || 'Invalid search request.',
          details: data?.message,
          suggestion: 'Check that the knowledge base is ready and your query is valid.',
        }
      } else if (status === 401) {
        return {
          type: 'Authentication Error',
          message: 'You are not authorized to perform this search.',
          suggestion: 'Please log in again or check your permissions.',
        }
      } else if (status === 404) {
        return {
          type: 'Not Found',
          message: data?.error || 'Knowledge base not found or not accessible.',
          suggestion: 'The knowledge base may have been deleted or is not ready yet.',
        }
      } else if (status === 502 || status === 503) {
        return {
          type: 'Service Unavailable',
          message: 'The KB retrieval service is temporarily unavailable.',
          details: data?.error || data?.message,
          suggestion: 'Please try again in a few moments.',
        }
      } else if (status >= 500) {
        return {
          type: 'Server Error',
          message: data?.error || 'An internal server error occurred.',
          details: data?.message,
          suggestion: 'Please try again or contact support if the issue persists.',
        }
      }

      return {
        type: `Error (${status})`,
        message: data?.error || data?.message || 'An unexpected error occurred.',
        details: JSON.stringify(data, null, 2),
      }
    }

    // Handle network errors
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return {
        type: 'Timeout',
        message: 'The search request timed out.',
        suggestion: 'Try reducing the number of results or simplifying your query.',
      }
    }

    if (err.code === 'ERR_NETWORK' || !navigator.onLine) {
      return {
        type: 'Network Error',
        message: 'Unable to connect to the server.',
        suggestion: 'Check your internet connection and try again.',
      }
    }

    // Fallback for unknown errors
    return {
      type: 'Error',
      message: err.message || 'An unexpected error occurred.',
      details: err.stack,
    }
  }

  const toggleRowExpansion = (resultId: string) => {
    setExpandedRows((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(resultId)) {
        newSet.delete(resultId)
      } else {
        newSet.add(resultId)
      }
      return newSet
    })
  }

  const getScoreBadgeColor = (score: number): 'success' | 'warning' | 'danger' | 'informative' => {
    if (score >= 0.8) return 'success'
    if (score >= 0.6) return 'warning'
    if (score >= 0.4) return 'informative'
    return 'danger'
  }

  const truncateText = (text: string, maxLength: number = 200): string => {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength) + '...'
  }

  const handleClose = () => {
    // Reset state on close
    setSearchResponse(null)
    setError(null)
    setExpandedRows(new Set())
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && handleClose()}>
      <DialogSurface className={styles.dialogSurface}>
        <DialogTitle>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Test Knowledge Base Retrieval</span>
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={handleClose}
              aria-label="Close"
            />
          </div>
        </DialogTitle>

        <DialogBody>
          <DialogContent>
            {/* Form Section */}
            <div className={styles.formSection}>
              {/* KB Selection */}
              <div className={styles.formField}>
                <Label required>Knowledge Base</Label>
                <Dropdown
                  placeholder="Select a knowledge base"
                  value={selectedKbName}
                  onOptionSelect={(_, data) => setSelectedKbId(data.optionValue || '')}
                  disabled={loading}
                >
                  {availableKBs.length === 0 ? (
                    <Option value="" text="No knowledge bases available" disabled>
                      No knowledge bases available (status must be "created")
                    </Option>
                  ) : (
                    availableKBs.map((kb) => (
                      <Option key={kb.id} value={kb.id} text={`${kb.name} (${kb.id})`}>
                        {kb.name} ({kb.id})
                      </Option>
                    ))
                  )}
                </Dropdown>
              </div>

              {/* Query Input */}
              <div className={styles.formField}>
                <Label required>Search Query</Label>
                <Textarea
                  placeholder="Enter your search query or prompt..."
                  value={query}
                  onChange={(_, data) => setQuery(data.value)}
                  disabled={loading}
                  rows={3}
                  resize="vertical"
                />
              </div>

              {/* Parameters */}
              <div className={styles.parametersRow}>
                <div className={styles.parameterField}>
                  <Label>Number of Results</Label>
                  <Input
                    type="number"
                    value={topK.toString()}
                    onChange={(_, data) => {
                      const parsed = parseInt(data.value, 10)
                      if (!isNaN(parsed)) {
                        // Clamp between 1 and 100
                        setTopK(Math.max(1, Math.min(100, parsed)))
                      }
                    }}
                    min={1}
                    max={100}
                    step={1}
                    disabled={loading}
                    style={{ width: '100px' }}
                  />
                </div>

                <div className={styles.parameterField}>
                  <Label>
                    <Tooltip
                      content="Minimum similarity score (0.0-1.0). Results below this threshold will be filtered out."
                      relationship="description"
                    >
                      <span>Min Score Threshold</span>
                    </Tooltip>
                  </Label>
                  <Input
                    type="number"
                    value={minScore.toString()}
                    onChange={(_, data) => {
                      const parsed = parseFloat(data.value)
                      if (!isNaN(parsed)) {
                        // Clamp between 0 and 1
                        setMinScore(Math.max(0, Math.min(1, parsed)))
                      } else if (data.value === '' || data.value === '0.' || data.value === '.') {
                        // Allow typing partial values like "0." 
                        setMinScore(0)
                      }
                    }}
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={loading}
                    style={{ width: '100px' }}
                  />
                </div>

                <Button
                  appearance="primary"
                  icon={loading ? <Spinner size="tiny" /> : <Search24Regular />}
                  onClick={handleSearch}
                  disabled={loading || !selectedKbId || !query.trim()}
                >
                  {loading ? 'Searching...' : 'Search'}
                </Button>
              </div>
              
              {/* Advanced Options Toggle */}
              <Button
                appearance="subtle"
                size="small"
                onClick={() => setShowAdvanced(!showAdvanced)}
                icon={showAdvanced ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
              >
                Advanced Options
              </Button>
              
              {/* Advanced Options Section */}
              {showAdvanced && (
                <div style={{ 
                  padding: '16px', 
                  backgroundColor: 'var(--colorNeutralBackground2)', 
                  borderRadius: '4px',
                  border: '1px solid var(--colorNeutralStroke1)'
                }}>
                  <div className={styles.parametersRow}>
                    <div className={styles.parameterField}>
                      <Label>Reranker</Label>
                      <Dropdown
                        value={RERANKER_OPTIONS.find(r => r.id === rerankerType)?.name || 'RRF (Default)'}
                        onOptionSelect={(_, data) => setRerankerType((data.optionValue as RerankerType) || 'rrf')}
                        disabled={loading}
                      >
                        {RERANKER_OPTIONS.map((opt) => (
                          <Option key={opt.id} value={opt.id} text={opt.name}>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <Text weight="semibold">{opt.name}</Text>
                              <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                                {opt.description}
                              </Text>
                            </div>
                          </Option>
                        ))}
                      </Dropdown>
                    </div>
                    
                    {rerankerType === 'linear' && (
                      <div className={styles.parameterField}>
                        <Label>
                          <Tooltip content="Weight for vector score (1 - weight = FTS weight)" relationship="description">
                            <span>Linear Weight</span>
                          </Tooltip>
                        </Label>
                        <Input
                          type="number"
                          value={linearWeight.toString()}
                          onChange={(_, data) => {
                            const parsed = parseFloat(data.value)
                            if (!isNaN(parsed)) {
                              setLinearWeight(Math.max(0, Math.min(1, parsed)))
                            }
                          }}
                          min={0}
                          max={1}
                          step={0.1}
                          disabled={loading}
                          style={{ width: '100px' }}
                        />
                      </div>
                    )}
                    
                    <div className={styles.parameterField}>
                      <Label>
                        <Tooltip content="Number of IVF partitions to search (for IVF_PQ / IVF_RQ indexed KBs)" relationship="description">
                          <span>nprobe (IVF)</span>
                        </Tooltip>
                      </Label>
                      <Input
                        type="number"
                        value={nprobe?.toString() || ''}
                        placeholder="Auto"
                        onChange={(_, data) => {
                          const parsed = parseInt(data.value, 10)
                          setNprobe(isNaN(parsed) ? undefined : Math.max(1, parsed))
                        }}
                        min={1}
                        disabled={loading}
                        style={{ width: '100px' }}
                      />
                    </div>
                    
                    <div className={styles.parameterField}>
                      <Label>
                        <Tooltip content="Re-rank top N*factor results for better accuracy" relationship="description">
                          <span>Refine Factor</span>
                        </Tooltip>
                      </Label>
                      <Input
                        type="number"
                        value={refineFactor?.toString() || ''}
                        placeholder="Auto"
                        onChange={(_, data) => {
                          const parsed = parseInt(data.value, 10)
                          setRefineFactor(isNaN(parsed) ? undefined : Math.max(1, parsed))
                        }}
                        min={1}
                        disabled={loading}
                        style={{ width: '100px' }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Error Display */}
            {error && (
              <MessageBar intent="error" style={{ marginBottom: '16px' }}>
                <MessageBarBody>
                  <MessageBarTitle>{error.type}</MessageBarTitle>
                  <Text>{error.message}</Text>
                  {error.suggestion && (
                    <Text block style={{ marginTop: '4px', fontStyle: 'italic' }}>
                      {error.suggestion}
                    </Text>
                  )}
                  {error.details && (
                    <div className={styles.errorDetails}>
                      <Text size={200}>{error.details}</Text>
                    </div>
                  )}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* Results Section */}
            {searchResponse && (
              <div className={styles.resultsSection}>
                {/* Results Header with Latency */}
                <div className={styles.resultsHeader}>
                  <Text weight="semibold">
                    {searchResponse.resultCount} result{searchResponse.resultCount !== 1 ? 's' : ''} found
                  </Text>
                  <div className={styles.latencyBadge}>
                    <Text size={200}>Latency:</Text>
                    <Badge appearance="outline" color="informative">
                      {searchResponse.processingTimeMs.toFixed(2)} ms
                    </Badge>
                  </div>
                </div>

                {/* Results Table */}
                {searchResponse.results.length === 0 ? (
                  <div className={styles.noResults}>
                    <Text>No results found matching your query with the specified threshold.</Text>
                    <Text block size={200} style={{ marginTop: '8px' }}>
                      Try lowering the minimum score threshold or modifying your query.
                    </Text>
                  </div>
                ) : (
                  <div className={styles.tableContainer}>
                    <Table className={styles.table}>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell className={styles.colExpand}></TableHeaderCell>
                          <TableHeaderCell className={styles.colScore}>Score</TableHeaderCell>
                          <TableHeaderCell className={styles.colText}>Text</TableHeaderCell>
                          <TableHeaderCell className={styles.colSource}>Source</TableHeaderCell>
                          <TableHeaderCell className={styles.colChunk}>Chunk</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {searchResponse.results.map((result: KBSearchResult) => (
                          <>
                            <TableRow key={result.id}>
                              <TableCell className={styles.colExpand}>
                                <Button
                                  appearance="subtle"
                                  size="small"
                                  className={styles.expandButton}
                                  icon={
                                    expandedRows.has(result.id) ? (
                                      <ChevronUp20Regular />
                                    ) : (
                                      <ChevronDown20Regular />
                                    )
                                  }
                                  onClick={() => toggleRowExpansion(result.id)}
                                  aria-label={expandedRows.has(result.id) ? 'Collapse' : 'Expand'}
                                />
                              </TableCell>
                              <TableCell className={styles.colScore}>
                                <div className={styles.scoreCell}>
                                  <Badge
                                    appearance="filled"
                                    color={getScoreBadgeColor(result.score)}
                                  >
                                    {(result.score * 100).toFixed(1)}%
                                  </Badge>
                                </div>
                              </TableCell>
                              <TableCell className={styles.colText}>
                                <Tooltip content="Click expand button to see full text" relationship="description">
                                  <span className={styles.truncatedText}>
                                    {truncateText(result.text, 150)}
                                  </span>
                                </Tooltip>
                              </TableCell>
                              <TableCell className={styles.colSource}>
                                <Tooltip
                                  content={result.metadata?.filePath || 'Unknown source'}
                                  relationship="label"
                                >
                                  <span className={styles.cellContent}>
                                    {result.metadata?.documentName ||
                                      result.metadata?.filePath ||
                                      'Unknown'}
                                  </span>
                                </Tooltip>
                              </TableCell>
                              <TableCell className={styles.colChunk}>
                                <Text>{result.chunkIndex}</Text>
                              </TableCell>
                            </TableRow>
                            {expandedRows.has(result.id) && (
                              <TableRow key={`${result.id}-expanded`}>
                                <TableCell colSpan={5} style={{ padding: 0 }}>
                                  <div className={styles.expandedText}>{result.text}</div>
                                </TableCell>
                              </TableRow>
                            )}
                          </>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            )}
          </DialogContent>

          <DialogActions>
            <Button appearance="secondary" onClick={handleClose}>
              Close
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
