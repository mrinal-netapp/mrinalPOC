import Ajv, { type ValidateFunction } from 'ajv';

/**
 * Meta-schema ("a schema of schemas") that constrains the shape every guardrail
 * `config_schema` must satisfy. It permits only a flat object whose properties
 * are scalars or arrays-of-scalars, and forces each property to declare `type`,
 * `is_required`, and `can_override`. A top-level `required` array is disallowed
 * (property requiredness is expressed solely via per-property `is_required`).
 *
 * This is plain JSON Schema (draft-07, Ajv's default dialect), so it compiles
 * with a standard Ajv instance — distinct from the service's `strict:false`
 * instance, which only exists to tolerate the custom `is_required` /
 * `can_override` keywords when compiling a stored `config_schema`.
 */
export const GUARDRAIL_CONFIG_SCHEMA_META = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['type', 'properties'],
  additionalProperties: false,
  properties: {
    type: { const: 'object' },
    additionalProperties: { type: 'boolean' },
    properties: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        required: ['type', 'is_required', 'can_override'],
        additionalProperties: false,
        properties: {
          type: { enum: ['string', 'boolean', 'number', 'integer', 'array'] },
          title: { type: 'string' },
          description: { type: 'string' },
          default: {},
          enum: { type: 'array' },
          items: {
            type: 'object',
            required: ['type'],
            additionalProperties: false,
            properties: {
              type: { enum: ['string', 'boolean', 'number', 'integer'] },
            },
          },
          is_required: { type: 'boolean' },
          can_override: { type: 'boolean' },
        },
        // An array property must declare `items` (a scalar element type), so
        // arrays are true arrays-of-scalars rather than arrays-of-anything.
        if: { properties: { type: { const: 'array' } } },
        then: { required: ['items'] },
      },
    },
  },
};

const ajv = new Ajv();
const validateMeta: ValidateFunction = ajv.compile(GUARDRAIL_CONFIG_SCHEMA_META);

/**
 * Validate the *shape* of a submitted `config_schema` against the meta-schema.
 * Pure and DB-free. Returns a list of human-readable error strings; an empty
 * array means the shape is valid.
 */
export function validateConfigSchemaShape(schema: unknown): string[] {
  if (validateMeta(schema)) return [];
  return (validateMeta.errors || []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message}`,
  );
}
