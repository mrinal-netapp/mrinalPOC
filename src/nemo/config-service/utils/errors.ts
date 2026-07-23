/**
 * Custom error classes for better error handling and type safety
 */

export class NotFoundError extends Error {
  public readonly statusCode = 404;

  constructor(entity: string, id?: string) {
    const message = id
      ? `${entity} with id ${id} not found`
      : `${entity} not found`;
    super(message);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

export class ValidationError extends Error {
  public readonly statusCode: number = 400;
  
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class ConflictError extends Error {
  public readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

export class BusinessLogicError extends Error {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'BusinessLogicError';
    Object.setPrototypeOf(this, BusinessLogicError.prototype);
  }
}

export class PayloadTooLargeError extends Error {
  public readonly statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
    Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
  }
}

/**
 * Map domain error classes to HTTP status. Returns 500 when the error is not a
 * known domain type (use {@link resolveHttpStatusCode} for API responses).
 */
export function getErrorStatusCode(error: Error): number {
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ValidationError) return 400;
  if (error instanceof ConflictError) return 409;
  if (error instanceof BusinessLogicError) return 400;
  if (error instanceof PayloadTooLargeError) return 413;
  return 500;
}

/** Errors that may carry an explicit HTTP status (domain classes or ad-hoc API errors). */
export type ErrorWithHttpStatus = Error & { statusCode?: number };

function isValidHttpStatus(code: number): boolean {
  return Number.isInteger(code) && code >= 400 && code < 600;
}

/**
 * Resolves the HTTP status code for JSON API error responses.
 *
 * Order: explicit `statusCode` on the error (4xx/5xx), then domain classes via
 * {@link getErrorStatusCode}, then conservative message heuristics for legacy
 * `throw new Error(...)` patterns.
 */
export function resolveHttpStatusCode(error: ErrorWithHttpStatus): number {
  if (typeof error.statusCode === 'number' && isValidHttpStatus(error.statusCode)) {
    return error.statusCode;
  }

  const domain = getErrorStatusCode(error);
  if (domain !== 500) {
    return domain;
  }

  const message = (error.message || '').toLowerCase();
  if (!message) {
    return 500;
  }
  if (message.includes('not found')) {
    return 404;
  }
  if (message.includes('already exists') || message.includes('draft manifest already exists')) {
    return 409;
  }
  if (message.includes('cannot') || message.includes('only draft') || message.includes('duplicate')) {
    return 400;
  }
  return 500;
}

