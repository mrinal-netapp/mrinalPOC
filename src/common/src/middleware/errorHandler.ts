import { Request, Response, NextFunction } from 'express';
import { ErrorResponse } from '../types/common';

/**
 * Creates error handling middleware with consistent error response format
 */
export function createErrorHandler(logLevel: string = 'info') {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    if (logLevel === 'debug') {
      console.error('Error:', err);
      console.error('Stack:', err.stack);
    } else {
      console.error('Error:', err.message);
    }

    // Default error response
    const errorResponse: ErrorResponse = {
      error: err.message || 'Internal server error',
      code: 'INTERNAL_ERROR'
    };

    // Add details in debug mode
    if (logLevel === 'debug' && err.stack) {
      errorResponse.details = { stack: err.stack };
    }

    res.status(500).json(errorResponse);
  };
}

