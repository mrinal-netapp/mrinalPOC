import { describe, expect, it } from "vitest"

import {
  getStructuredOutputSaveError,
  isValidJsonSchema,
  parseAndValidateJsonSchema,
  validateStructuredOutputSchema,
} from "./json-schema-validation"

describe("json-schema-validation", () => {
  it("[tag:json-schema-validation] rejects arbitrary JSON objects", () => {
    expect(
      isValidJsonSchema('{"message":"hello","count":1,"active":true}'),
    ).toBe(false)
    expect(
      parseAndValidateJsonSchema('{"message":"hello","count":1,"active":true}'),
    ).toBeNull()
  })

  it("[tag:json-schema-validation] accepts minimal JSON Schema documents", () => {
    const schema = '{"type":"object","properties":{"x":{"type":"string"}}}'
    expect(isValidJsonSchema(schema)).toBe(true)
    expect(parseAndValidateJsonSchema(schema)).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    })
  })

  it("[tag:json-schema-validation] accepts schemas that declare $id for $ref resolution", () => {
    const schema = JSON.stringify({
      $id: "https://example.com/root.schema.json",
      $defs: {
        name: { type: "string" },
      },
      type: "object",
      properties: {
        name: { $ref: "#/$defs/name" },
      },
    })
    expect(isValidJsonSchema(schema)).toBe(true)
    expect(parseAndValidateJsonSchema(schema)).toEqual({
      $id: "https://example.com/root.schema.json",
      $defs: {
        name: { type: "string" },
      },
      type: "object",
      properties: {
        name: { $ref: "#/$defs/name" },
      },
    })
  })

  it("[tag:json-schema-validation] repeated validations keep the shared AJV instance healthy", () => {
    const withId = JSON.stringify({
      $id: "https://example.com/repeated.schema.json",
      type: "object",
    })
    const withoutId = '{"type":"object","properties":{"x":{"type":"string"}}}'
    expect(isValidJsonSchema(withId)).toBe(true)
    expect(isValidJsonSchema(withId)).toBe(true)
    expect(isValidJsonSchema(withoutId)).toBe(true)
  })

  it("[tag:json-schema-validation] rejects boolean JSON Schemas because only objects are accepted", () => {
    expect(isValidJsonSchema("true")).toBe(false)
    expect(parseAndValidateJsonSchema("true")).toBeNull()
  })

  it("[tag:json-schema-validation] distinguishes blank vs invalid structured-output schema", () => {
    expect(validateStructuredOutputSchema("", "json_object")).toEqual({ ok: false, reason: "empty" })
    expect(validateStructuredOutputSchema('{"message":"hello"}', "json_object")).toEqual({
      ok: false,
      reason: "invalid",
    })
    expect(getStructuredOutputSaveError("", "json_object")).toBe(
      "JSON schema is required when Structured output is enabled.",
    )
    expect(getStructuredOutputSaveError('{"message":"hello"}', "json_object")).toBe(
      "Structured output schema must be a valid JSON Schema object when Structured output is enabled.",
    )
  })
})
