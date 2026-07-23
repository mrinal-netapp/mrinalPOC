import { useState, useCallback } from 'react'
import {
  makeStyles,
  tokens,
  Button,
  Input,
  Text,
  Dropdown,
  Option,
} from '@fluentui/react-components'
import {
  Add20Regular,
  Dismiss16Regular,
  Filter20Regular,
  DismissCircle20Regular,
} from '@fluentui/react-icons'
import { classifyDuckDBType, type ColumnTypeCategory } from '../../utils/duckdb-types'
import type { FilterCriteria } from '../../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  columnDropdown: {
    minWidth: '160px',
  },
  operatorDropdown: {
    minWidth: '120px',
  },
  valueInput: {
    minWidth: '140px',
    flex: '1 1 140px',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '4px',
  },
  andLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    padding: '0 4px',
  },
})

const operatorsByCategory: Record<ColumnTypeCategory, FilterCriteria['op'][]> = {
  integer: ['=', '!=', '>', '<', '>=', '<=', 'IS NULL', 'IS NOT NULL', 'IN'],
  float: ['=', '!=', '>', '<', '>=', '<=', 'IS NULL', 'IS NOT NULL', 'IN'],
  string: ['=', '!=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL', 'IN'],
  temporal: ['=', '!=', '>', '<', '>=', '<=', 'IS NULL', 'IS NOT NULL'],
  boolean: ['=', '!=', 'IS NULL', 'IS NOT NULL'],
  other: ['=', '!=', 'IS NULL', 'IS NOT NULL'],
}

interface FilterRow {
  id: number
  column: string
  op: FilterCriteria['op']
  value: string
}

interface FilterBuilderProps {
  columns: string[]
  columnTypes: string[]
  onApply: (filters: FilterCriteria[]) => void
  onClear: () => void
}

let nextId = 0

export function FilterBuilder({ columns, columnTypes, onApply, onClear }: FilterBuilderProps) {
  const styles = useStyles()
  const [filters, setFilters] = useState<FilterRow[]>([])

  const getTypeCategory = useCallback(
    (colName: string): ColumnTypeCategory => {
      const idx = columns.indexOf(colName)
      if (idx < 0 || idx >= columnTypes.length) return 'other'
      return classifyDuckDBType(columnTypes[idx])
    },
    [columns, columnTypes],
  )

  const addFilter = () => {
    setFilters((prev) => [
      ...prev,
      { id: ++nextId, column: columns[0] ?? '', op: '=', value: '' },
    ])
  }

  const removeFilter = (id: number) => {
    setFilters((prev) => prev.filter((f) => f.id !== id))
  }

  const updateFilter = (id: number, field: keyof FilterRow, value: string) => {
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f
        const updated = { ...f, [field]: value }
        if (field === 'column') {
          const cat = getTypeCategory(value)
          const ops = operatorsByCategory[cat]
          if (!ops.includes(updated.op)) {
            updated.op = ops[0]
          }
        }
        return updated
      }),
    )
  }

  const handleApply = () => {
    const valid = filters
      .filter((f) => f.column)
      .map((f): FilterCriteria => {
        const isNullOp = f.op === 'IS NULL' || f.op === 'IS NOT NULL'
        return {
          column: f.column,
          op: f.op,
          value: isNullOp ? undefined : f.value,
        }
      })
    onApply(valid)
  }

  const handleClear = () => {
    setFilters([])
    onClear()
  }

  const noValue = (op: string) => op === 'IS NULL' || op === 'IS NOT NULL'

  return (
    <div className={styles.container}>
      {filters.map((f, idx) => {
        const cat = getTypeCategory(f.column)
        const ops = operatorsByCategory[cat]
        return (
          <div key={f.id}>
            {idx > 0 && <Text className={styles.andLabel}>AND</Text>}
            <div className={styles.filterRow}>
              <Dropdown
                className={styles.columnDropdown}
                placeholder="Column"
                value={f.column}
                selectedOptions={[f.column]}
                onOptionSelect={(_e, data) => updateFilter(f.id, 'column', data.optionValue ?? '')}
              >
                {columns.map((c) => (
                  <Option key={c} value={c}>{c}</Option>
                ))}
              </Dropdown>
              <Dropdown
                className={styles.operatorDropdown}
                placeholder="Operator"
                value={f.op}
                selectedOptions={[f.op]}
                onOptionSelect={(_e, data) => updateFilter(f.id, 'op', data.optionValue ?? '=')}
              >
                {ops.map((op) => (
                  <Option key={op} value={op}>{op}</Option>
                ))}
              </Dropdown>
              {!noValue(f.op) && (
                <Input
                  className={styles.valueInput}
                  placeholder="Value"
                  value={f.value}
                  onChange={(_e, data) => updateFilter(f.id, 'value', data.value)}
                />
              )}
              <Button
                icon={<Dismiss16Regular />}
                appearance="subtle"
                size="small"
                onClick={() => removeFilter(f.id)}
              />
            </div>
          </div>
        )
      })}
      <div className={styles.actions}>
        <Button
          icon={<Add20Regular />}
          appearance="subtle"
          size="small"
          onClick={addFilter}
        >
          Add filter
        </Button>
        {filters.length > 0 && (
          <>
            <Button
              icon={<Filter20Regular />}
              appearance="primary"
              size="small"
              onClick={handleApply}
            >
              Apply Filters
            </Button>
            <Button
              icon={<DismissCircle20Regular />}
              appearance="subtle"
              size="small"
              onClick={handleClear}
            >
              Clear All
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
