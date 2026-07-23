import { Request, Response, RequestHandler } from 'express';
import { validationResult } from 'express-validator';
import { resolveHttpStatusCode } from './errors';

/**
 * Wrapper for async route handlers to catch errors
 */
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Validate request using express-validator
 */
export function validateRequest(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return false;
  }
  return true;
}

/**
 * Send success response
 */
export function sendSuccess<T>(res: Response, data: T, statusCode: number = 200): void {
  res.status(statusCode).json(data);
}

/**
 * Send error response
 */
export function sendError(res: Response, error: Error, statusCode?: number): void {
  const code = statusCode ?? resolveHttpStatusCode(error);
  res.status(code).json({ 
    error: error.message,
    name: error.name 
  });
}

/**
 * Standard CRUD route handlers factory
 */
export interface CrudRouteHandlers<T> {
  create: RequestHandler;
  getById: RequestHandler;
  update: RequestHandler;
  delete: RequestHandler;
  list: RequestHandler;
}

/**
 * Create standard CRUD route handlers
 */
export function createCrudHandlers<TEntity, TModel>(options: {
  create: (data: Partial<TModel>) => Promise<TModel>;
  getById: (id: string) => Promise<TModel | null>;
  update: (id: string, data: Partial<TModel>) => Promise<TModel>;
  delete: (id: string) => Promise<boolean>;
  list: () => Promise<TModel[]>;
  entityName: string;
}): CrudRouteHandlers<TModel> {
  return {
    create: asyncHandler(async (req: Request, res: Response) => {
      if (!validateRequest(req, res)) return;
      const entity = await options.create(req.body);
      sendSuccess(res, entity, 201);
    }),

    getById: asyncHandler(async (req: Request, res: Response) => {
      const entity = await options.getById(req.params.id);
      if (!entity) {
        return sendError(res, new Error(`${options.entityName} not found`), 404);
      }
      sendSuccess(res, entity);
    }),

    update: asyncHandler(async (req: Request, res: Response) => {
      if (!validateRequest(req, res)) return;
      const entity = await options.update(req.params.id, req.body);
      sendSuccess(res, entity);
    }),

    delete: asyncHandler(async (req: Request, res: Response) => {
      const deleted = await options.delete(req.params.id);
      if (!deleted) {
        return sendError(res, new Error(`${options.entityName} not found`), 404);
      }
      sendSuccess(res, { deleted: true });
    }),

    list: asyncHandler(async (req: Request, res: Response) => {
      const entities = await options.list();
      sendSuccess(res, entities);
    }),
  };
}

