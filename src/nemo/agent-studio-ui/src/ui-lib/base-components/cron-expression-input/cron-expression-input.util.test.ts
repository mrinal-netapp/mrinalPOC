import { describe, expect, it } from "vitest"

import { validateCronExpression, valueFromFieldValidatorParam } from "./cron-expression-input.util"

describe("validateCronExpression", () => {
  it("accepts valid five-field expressions", () => {
    expect(validateCronExpression("0 10 * * *")).toBeUndefined()
    expect(validateCronExpression("*/5 * * * *")).toBeUndefined()
    expect(validateCronExpression("0 0 1 1 0")).toBeUndefined()
    expect(validateCronExpression("0 0 1,2,3 * *")).toBeUndefined()
  })

  it("rejects empty or wrong part count", () => {
    expect(validateCronExpression("")).toMatch(/Enter a cron expression/)
    expect(validateCronExpression("   ")).toMatch(/Enter a cron expression/)
    expect(validateCronExpression("0 0 0 0")).toMatch(/Use five space-separated parts/)
    expect(validateCronExpression("0 0 0 0 0 0")).toMatch(/Too many fields/)
  })

  it("rejects out-of-range by field (minute, hour, dom, month, dow)", () => {
    expect(validateCronExpression("60 * * * *")).toMatch(/Minute/)
    expect(validateCronExpression("0 24 * * *")).toMatch(/Hour/)
    expect(validateCronExpression("* * 0 * *")).toMatch(/Day of month/)
    expect(validateCronExpression("* * 32 * *")).toMatch(/Day of month/)
    expect(validateCronExpression("* * * 13 *")).toMatch(/Month/)
    expect(validateCronExpression("* * * * 7")).toMatch(/Day of week/)
    expect(validateCronExpression("* * * * 9")).toMatch(/Day of week/)
  })

  it("rejects */0 and invalid step", () => {
    expect(validateCronExpression("*/0 * * * *")).toMatch(/step must be at least 1/)
  })

  it("rejects minute 300 in the first field", () => {
    expect(validateCronExpression("300 * * * *")).toMatch(/Minute/)
  })

  it("rejects * in a comma list", () => {
    expect(validateCronExpression("*,0 * * * *")).toMatch(/cannot be combined/)
  })

  // -- validateSegment: step branches --

  it("rejects */abc (non-numeric rest after */)", () => {
    expect(validateCronExpression("*/abc * * * *")).toMatch(/invalid step/)
  })

  it("rejects */ with empty rest", () => {
    // "*/" has an empty rest
    expect(validateCronExpression("*/ * * * *")).toMatch(/invalid step/)
  })

  it("rejects step exceeding maxStep (*/60 in minute field, maxStep=59)", () => {
    expect(validateCronExpression("*/60 * * * *")).toMatch(/step must be at most 59/)
  })

  // -- validateSegment: range branches --

  it("accepts a valid range without step (1-5 in minute)", () => {
    expect(validateCronExpression("1-5 * * * *")).toBeUndefined()
  })

  it("accepts a valid range with step (1-30/5 in minute)", () => {
    expect(validateCronExpression("1-30/5 * * * *")).toBeUndefined()
  })

  it("rejects a range where both bounds are out of range (60-65 in minute)", () => {
    expect(validateCronExpression("60-65 * * * *")).toMatch(/Minute/)
  })

  it("rejects a descending range (5-3 in minute)", () => {
    expect(validateCronExpression("5-3 * * * *")).toMatch(/increasing range/)
  })

  it("rejects a range step of 0 (1-5/0 in minute)", () => {
    expect(validateCronExpression("1-5/0 * * * *")).toMatch(/range step/)
  })

  it("rejects a range step exceeding maxStep (1-5/60 in minute, maxStep=59)", () => {
    expect(validateCronExpression("1-5/60 * * * *")).toMatch(/range step/)
  })

  it("rejects a completely unrecognised segment (@hourly)", () => {
    expect(validateCronExpression("@hourly * * * *")).toMatch(/not valid/)
  })

  // -- validateCronFieldValue: empty segment list --

  it("rejects a field that produces no segments after filtering (e.g. ',')", () => {
    // "," splits to ["",""] → filter removes both → segments.length === 0
    expect(validateCronExpression("0 , * * *")).toMatch(/Hour/)
  })
})

// ---------------------------------------------------------------------------
// valueFromFieldValidatorParam
// ---------------------------------------------------------------------------

describe("valueFromFieldValidatorParam", () => {
  it("returns empty string for null", () => {
    expect(valueFromFieldValidatorParam(null)).toBe("")
  })

  it("returns empty string for undefined", () => {
    expect(valueFromFieldValidatorParam(undefined)).toBe("")
  })

  it("returns stringified primitive string", () => {
    expect(valueFromFieldValidatorParam("hello")).toBe("hello")
  })

  it("returns stringified number", () => {
    expect(valueFromFieldValidatorParam(42)).toBe("42")
  })

  it("returns stringified boolean", () => {
    expect(valueFromFieldValidatorParam(true)).toBe("true")
  })

  it("returns empty string when object has value=null", () => {
    expect(valueFromFieldValidatorParam({ value: null })).toBe("")
  })

  it("returns stringified value when object has string value", () => {
    expect(valueFromFieldValidatorParam({ value: "* * * * *" })).toBe("* * * * *")
  })

  it("returns stringified value when object has numeric value", () => {
    expect(valueFromFieldValidatorParam({ value: 5 })).toBe("5")
  })

  it("returns stringified value when object has boolean value", () => {
    expect(valueFromFieldValidatorParam({ value: false })).toBe("false")
  })

  it("returns stringified value when object value is an object (non-primitive)", () => {
    expect(valueFromFieldValidatorParam({ value: { x: 1 } })).toBe("[object Object]")
  })

  it("returns empty string for a non-object non-primitive (e.g. a function)", () => {
    // Functions are typeof "function" — none of the branches match → falls through to ""
    expect(valueFromFieldValidatorParam(() => { })).toBe("")
  })
})
