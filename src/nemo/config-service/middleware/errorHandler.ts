import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Request, Response, NextFunction } from 'express';
import { sendErrorResponse } from '../utils/errorHandler';

/**
 * Global error handling middleware
 * Catches all errors and sends appropriate HTTP responses
 */
export function errorHandlerMiddleware(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log error for debugging
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // Use centralized error handling
  sendErrorResponse(res, err);
}

/**
 * 404 handler for unmatched routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`,
  });
}

