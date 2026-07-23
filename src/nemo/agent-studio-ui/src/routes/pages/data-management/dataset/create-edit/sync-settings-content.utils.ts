// Same rules on blur and submit: users can still type "-" mid-edit without
// onChange errors; once the field blurs, invalid/empty values show an error.
export function runScheduleNumericRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): string | undefined {
  if (value === null || value === undefined) {
    return `${label} is required`;
  }
  const s = String(value).trim();
  if (s === "" || s === "-") {
    return `${label} is required`;
  }
  const n = Number(s);
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    return `${label} must be a number`;
  }
  if (n < min || n > max) {
    return `${label} must be between ${min} and ${max}`;
  }
  return undefined;
}

type FieldValidator = (opts: { value: unknown }) => string | undefined;

interface RangeValidators {
  onBlur: FieldValidator;
  onSubmit: FieldValidator;
}

export function rangeValidator(min: number, max: number, label: string): RangeValidators {
  return {
    onBlur: ({ value }) => runScheduleNumericRange(value, min, max, label),
    onSubmit: ({ value }) => runScheduleNumericRange(value, min, max, label),
  };
}
