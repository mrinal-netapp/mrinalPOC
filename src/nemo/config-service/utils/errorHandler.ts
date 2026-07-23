import { Response } from 'express';
import { resolveHttpStatusCode, type ErrorWithHttpStatus } from './errors';

export interface ApiError extends Error {
  statusCode?: number;
}

/** Delegates to {@link resolveHttpStatusCode} in `./errors` (domain types + legacy message hints). */
export function getStatusCodeFromError(error: ApiError | Error): number {
  return resolveHttpStatusCode(error as ErrorWithHttpStatus);
}

/**
 * Sends error response with appropriate status code
 */
export function sendErrorResponse(res: Response, error: ApiError | Error): void {
  const statusCode = getStatusCodeFromError(error);
  res.status(statusCode).json({ error: error.message });
}

