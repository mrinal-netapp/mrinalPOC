export type ColumnTypeCategory = 'integer' | 'float' | 'string' | 'temporal' | 'boolean' | 'other'

export function classifyDuckDBType(dbType: string): ColumnTypeCategory {
  const t = dbType.toUpperCase()
  if (
    ['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT',
      'HUGEINT', 'UBIGINT', 'UINTEGER', 'USMALLINT', 'UTINYINT'].some(n => t.includes(n))
  )
    return 'integer'
  if (['DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC'].some(n => t.includes(n)))
    return 'float'
  if (['VARCHAR', 'TEXT', 'CHAR', 'BLOB', 'UUID', 'ENUM'].some(n => t.includes(n)))
    return 'string'
  if (['TIMESTAMP', 'DATE', 'TIME', 'INTERVAL'].some(n => t.includes(n)))
    return 'temporal'
  if (t === 'BOOLEAN') return 'boolean'
  return 'other'
}

export function isNumericCategory(cat: ColumnTypeCategory | string): boolean {
  return cat === 'integer' || cat === 'float'
}
