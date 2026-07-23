import { useState, useEffect, useRef } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Button,
  Input,
  Dropdown,
  Option,
  Checkbox,
} from '@fluentui/react-components'
import {
  Add24Regular,
  Delete24Regular,
  ReOrderDotsVertical24Regular,
} from '@fluentui/react-icons'

export interface FieldConstraints {
  required?: boolean
  unique?: boolean
  minLength?: number | null
  maxLength?: number | null
  minimum?: number | null
  maximum?: number | null
  pattern?: string
  format?: string
  enum?: string[] | null
  default?: string
  description?: string
}

export interface SchemaField {
  id: string
  fieldName: string
  dataType: string
  constraints: FieldConstraints
}

export interface SchemaBuilderProps {
  value?: Record<string, any>
  onChange: (schema: Record<string, any> | undefined) => void
}

const DATA_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
  'date',
  'datetime',
  'timestamp',
]

const STRING_FORMATS = [
  'email',
  'uri',
  'date',
  'date-time',
  'time',
  'uuid',
  'hostname',
  'ipv4',
  'ipv6',
]

interface ConstraintsEditorProps {
  constraints: FieldConstraints
  dataType: string
  onChange: (constraints: FieldConstraints) => void
}

function ConstraintsEditor({ constraints, dataType, onChange }: ConstraintsEditorProps) {
  const updateConstraint = <K extends keyof FieldConstraints>(key: K, value: FieldConstraints[K]) => {
    onChange({ ...constraints, [key]: value })
  }

  const isStringType = dataType === 'string'
  const isNumericType = dataType === 'number' || dataType === 'integer'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', fontSize: '11px', maxWidth: '100%' }}>
      {/* Checkboxes for boolean constraints */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'nowrap' }}>
        <Checkbox
          label="Required"
          checked={constraints.required || false}
          onChange={(_, data) => updateConstraint('required', data.checked === true)}
          style={{ fontSize: '11px', flexShrink: 0 }}
        />
        <Checkbox
          label="Unique"
          checked={constraints.unique || false}
          onChange={(_, data) => updateConstraint('unique', data.checked === true)}
          style={{ fontSize: '11px', flexShrink: 0 }}
        />
      </div>

      {/* String-specific constraints */}
      {isStringType && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
            <Input
              type="number"
              placeholder="Min Length"
              value={constraints.minLength?.toString() || ''}
              onChange={(e) => {
                const val = e.target.value
                updateConstraint('minLength', val ? parseInt(val, 10) : null)
              }}
              style={{ width: '90px', fontSize: '11px', padding: '4px 6px', flexShrink: 0 }}
            />
            <span style={{ fontSize: '11px', color: 'var(--colorNeutralForeground3)', flexShrink: 0 }}>to</span>
            <Input
              type="number"
              placeholder="Max Length"
              value={constraints.maxLength?.toString() || ''}
              onChange={(e) => {
                const val = e.target.value
                updateConstraint('maxLength', val ? parseInt(val, 10) : null)
              }}
              style={{ width: '90px', fontSize: '11px', padding: '4px 6px', flexShrink: 0 }}
            />
            <div style={{ flex: 1 }}></div>
          </div>
          <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
            <Dropdown
              placeholder="Format"
              value={constraints.format || ''}
              onOptionSelect={(_, data) => updateConstraint('format', data.optionValue || '')}
              style={{ width: '180px', fontSize: '11px', flexShrink: 0 }}
            >
              <Option value="">None</Option>
              {STRING_FORMATS.map((format) => (
                <Option key={format} value={format}>
                  {format}
                </Option>
              ))}
            </Dropdown>
            <Input
              placeholder="Pattern (regex)"
              value={constraints.pattern || ''}
              onChange={(e) => updateConstraint('pattern', e.target.value)}
              style={{ flex: 1, fontSize: '11px', padding: '4px 6px', minWidth: '150px' }}
            />
          </div>
        </div>
      )}

      {/* Numeric-specific constraints */}
      {isNumericType && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', width: '100%' }}>
          <Input
            type="number"
            placeholder="Minimum"
            value={constraints.minimum?.toString() || ''}
            onChange={(e) => {
              const val = e.target.value
              updateConstraint('minimum', val ? parseFloat(val) : null)
            }}
            style={{ width: '120px', fontSize: '11px', padding: '4px 6px', flexShrink: 0 }}
          />
          <span style={{ fontSize: '11px', color: 'var(--colorNeutralForeground3)', flexShrink: 0 }}>to</span>
          <Input
            type="number"
            placeholder="Maximum"
            value={constraints.maximum?.toString() || ''}
            onChange={(e) => {
              const val = e.target.value
              updateConstraint('maximum', val ? parseFloat(val) : null)
            }}
            style={{ width: '120px', fontSize: '11px', padding: '4px 6px', flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}></div>
        </div>
      )}

      {/* Common constraints */}
      <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
        <Input
          placeholder="Default value"
          value={constraints.default || ''}
          onChange={(e) => updateConstraint('default', e.target.value)}
          style={{ flex: 1, fontSize: '11px', padding: '4px 6px', minWidth: '150px' }}
        />
        <Input
          placeholder="Description"
          value={constraints.description || ''}
          onChange={(e) => updateConstraint('description', e.target.value)}
          style={{ flex: 1, fontSize: '11px', padding: '4px 6px', minWidth: '150px' }}
        />
      </div>
    </div>
  )
}

// Convert JSON schema to table format
function jsonSchemaToFields(schema: Record<string, any>): SchemaField[] {
  if (!schema || !schema.properties) {
    return []
  }

  const requiredFields = schema.required || []
  const fields: SchemaField[] = []
  
  Object.entries(schema.properties).forEach(([fieldName, fieldSchema]: [string, any], index) => {
    const dataType = fieldSchema.type || 'string'
    const constraints: FieldConstraints = {
      required: requiredFields.includes(fieldName),
      unique: fieldSchema.unique || false,
      minLength: fieldSchema.minLength ?? null,
      maxLength: fieldSchema.maxLength ?? null,
      minimum: fieldSchema.minimum ?? null,
      maximum: fieldSchema.maximum ?? null,
      pattern: fieldSchema.pattern || '',
      format: fieldSchema.format || '',
      enum: fieldSchema.enum || null,
      default: fieldSchema.default !== undefined ? String(fieldSchema.default) : '',
      description: fieldSchema.description || '',
    }

    fields.push({
      id: `field-${index}-${fieldName}`,
      fieldName,
      dataType,
      constraints,
    })
  })

  return fields
}

// Convert table format to JSON schema
function fieldsToJsonSchema(fields: SchemaField[]): Record<string, any> | undefined {
  if (fields.length === 0) {
    return undefined
  }

  const properties: Record<string, any> = {}
  const required: string[] = []

  fields.forEach((field) => {
    if (!field.fieldName.trim()) {
      return // Skip empty field names
    }

    const fieldSchema: Record<string, any> = {
      type: field.dataType,
    }

    const constraints = field.constraints

    // Handle required
    if (constraints.required) {
      required.push(field.fieldName)
    }

    // Handle unique
    if (constraints.unique) {
      fieldSchema.unique = true
    }

    // Handle numeric constraints
    if (constraints.minLength !== null && constraints.minLength !== undefined) {
      fieldSchema.minLength = constraints.minLength
    }
    if (constraints.maxLength !== null && constraints.maxLength !== undefined) {
      fieldSchema.maxLength = constraints.maxLength
    }
    if (constraints.minimum !== null && constraints.minimum !== undefined) {
      fieldSchema.minimum = constraints.minimum
    }
    if (constraints.maximum !== null && constraints.maximum !== undefined) {
      fieldSchema.maximum = constraints.maximum
    }

    // Handle string constraints
    if (constraints.pattern) {
      fieldSchema.pattern = constraints.pattern
    }
    if (constraints.format) {
      fieldSchema.format = constraints.format
    }
    if (constraints.description) {
      fieldSchema.description = constraints.description
    }

    // Handle enum
    if (constraints.enum && constraints.enum.length > 0) {
      fieldSchema.enum = constraints.enum
    }

    // Handle default value
    if (constraints.default) {
      // Try to parse as appropriate type
      if (field.dataType === 'number' || field.dataType === 'integer') {
        const numValue = parseFloat(constraints.default)
        if (!isNaN(numValue)) {
          fieldSchema.default = field.dataType === 'integer' ? Math.floor(numValue) : numValue
        } else {
          fieldSchema.default = constraints.default
        }
      } else if (field.dataType === 'boolean') {
        fieldSchema.default = constraints.default === 'true' || constraints.default === '1'
      } else {
        fieldSchema.default = constraints.default
      }
    }

    properties[field.fieldName] = fieldSchema
  })

  const schema: Record<string, any> = {
    type: 'object',
    properties,
  }

  if (required.length > 0) {
    schema.required = required
  }

  return schema
}

export function SchemaBuilder({ value, onChange }: SchemaBuilderProps) {
  const [fields, setFields] = useState<SchemaField[]>(() => {
    if (value) {
      return jsonSchemaToFields(value)
    }
    return []
  })

  // Update fields when value prop changes (e.g., when loading existing schema)
  // Use a ref to track if we're updating from internal changes
  const isInternalUpdate = useRef(false)
  
  useEffect(() => {
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false
      return
    }
    
    if (value) {
      const newFields = jsonSchemaToFields(value)
      // Only update if fields are actually different to avoid unnecessary re-renders
      const fieldsStr = JSON.stringify(fields.map(f => ({ name: f.fieldName, type: f.dataType, constraints: f.constraints })))
      const newFieldsStr = JSON.stringify(newFields.map(f => ({ name: f.fieldName, type: f.dataType, constraints: f.constraints })))
      if (fieldsStr !== newFieldsStr) {
        setFields(newFields)
      }
    } else if (fields.length === 0) {
      // Only reset if fields is empty to avoid clearing user input
      setFields([])
    }
  }, [value])

  // Convert fields to JSON schema and notify parent
  useEffect(() => {
    isInternalUpdate.current = true
    const schema = fieldsToJsonSchema(fields)
    onChange(schema)
  }, [fields, onChange])

  const addField = () => {
    const newField: SchemaField = {
      id: `field-${Date.now()}`,
      fieldName: '',
      dataType: 'string',
      constraints: {
        required: false,
        unique: false,
        minLength: null,
        maxLength: null,
        minimum: null,
        maximum: null,
        pattern: '',
        format: '',
        enum: null,
        default: '',
        description: '',
      },
    }
    setFields([...fields, newField])
  }

  const removeField = (id: string) => {
    setFields(fields.filter((f) => f.id !== id))
  }

  const updateField = (id: string, updates: Partial<SchemaField>) => {
    setFields(
      fields.map((f) => (f.id === id ? { ...f, ...updates } : f))
    )
  }

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const handleDragStart = (index: number) => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return

    const newFields = [...fields]
    const draggedItem = newFields[draggedIndex]
    newFields.splice(draggedIndex, 1)
    newFields.splice(index, 0, draggedItem)
    setFields(newFields)
    setDraggedIndex(index)
  }

  const handleDragEnd = () => {
    setDraggedIndex(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Schema Fields</h4>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
            Define the structure of your data by adding fields with their types and constraints
          </p>
        </div>
        <Button
          appearance="primary"
          icon={<Add24Regular />}
          onClick={addField}
        >
          Add Field
        </Button>
      </div>

      {fields.length === 0 ? (
        <div
          style={{
            padding: '24px',
            textAlign: 'center',
            backgroundColor: 'var(--colorNeutralBackground2)',
            borderRadius: '4px',
            border: '1px dashed var(--colorNeutralStroke1)',
          }}
        >
          <p style={{ margin: 0, color: 'var(--colorNeutralForeground3)' }}>
            No fields defined. Click "Add Field" to start building your schema.
          </p>
        </div>
      ) : (
        <div style={{ border: '1px solid var(--colorNeutralStroke1)', borderRadius: '4px', overflowX: 'auto', overflowY: 'visible', maxWidth: '100%' }}>
          <Table style={{ tableLayout: 'fixed', width: '100%', minWidth: '1000px' }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: '40px', minWidth: '40px', padding: '4px', fontSize: '11px' }}></TableHeaderCell>
                <TableHeaderCell style={{ width: '180px', minWidth: '180px', padding: '4px', fontSize: '11px' }}>Field Name</TableHeaderCell>
                <TableHeaderCell style={{ width: '140px', minWidth: '140px', padding: '4px', fontSize: '11px' }}>Data Type</TableHeaderCell>
                <TableHeaderCell style={{ width: '580px', minWidth: '580px', padding: '4px', fontSize: '11px' }}>Constraints</TableHeaderCell>
                <TableHeaderCell style={{ width: '60px', minWidth: '60px', padding: '4px', fontSize: '11px' }}>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.map((field, index) => (
                <TableRow 
                  key={field.id}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  style={{ 
                    cursor: 'move',
                    opacity: draggedIndex === index ? 0.5 : 1
                  }}
                >
                  <TableCell style={{ width: '40px', minWidth: '40px', padding: '4px', textAlign: 'center', verticalAlign: 'top' }}>
                    <div
                      style={{
                        cursor: 'grab',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--colorNeutralForeground3)',
                        paddingTop: '8px',
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <ReOrderDotsVertical24Regular style={{ fontSize: '16px' }} />
                    </div>
                  </TableCell>
                  <TableCell style={{ width: '180px', minWidth: '180px', padding: '4px', verticalAlign: 'top' }}>
                    <Input
                      value={field.fieldName}
                      onChange={(e) => updateField(field.id, { fieldName: e.target.value })}
                      placeholder="field_name"
                      style={{ width: '100%', maxWidth: '100%', fontSize: '11px', padding: '4px 8px' }}
                    />
                  </TableCell>
                  <TableCell style={{ width: '140px', minWidth: '140px', padding: '4px', verticalAlign: 'top' }}>
                    <Dropdown
                      value={field.dataType}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) {
                          updateField(field.id, { dataType: data.optionValue })
                        }
                      }}
                      style={{ width: '100%', maxWidth: '100%', fontSize: '11px' }}
                    >
                      {DATA_TYPES.map((type) => (
                        <Option key={type} value={type}>
                          {type}
                        </Option>
                      ))}
                    </Dropdown>
                  </TableCell>
                  <TableCell style={{ width: '580px', minWidth: '580px', padding: '4px', overflow: 'visible', verticalAlign: 'top' }}>
                    <ConstraintsEditor
                      constraints={field.constraints}
                      dataType={field.dataType}
                      onChange={(newConstraints) => updateField(field.id, { constraints: newConstraints })}
                    />
                  </TableCell>
                  <TableCell style={{ width: '60px', minWidth: '60px', padding: '4px', textAlign: 'center', verticalAlign: 'top' }}>
                    <Button
                      appearance="subtle"
                      icon={<Delete24Regular />}
                      onClick={() => removeField(field.id)}
                      aria-label="Delete field"
                      size="small"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

