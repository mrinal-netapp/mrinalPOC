import { z } from 'zod/v3';

/**
 * Zod schemas matching the MCP tool argument shapes in handlers.ts.
 * Kept here so the McpServer registration and unit tests share a single
 * source of truth.
 */
export const StoreIdField = z
  .string()
  .regex(/^as[0-9a-z]{8}$/, 'store_id must look like asXXXXXXXX');

export const PathField = z
  .string()
  .min(1)
  .refine((p) => !p.includes('..'), 'path may not contain ".."');

export const RefField = z
  .string()
  .min(1)
  .max(255)
  .optional();

export const ListStoresSchema = z.object({
  project_id: z.string().optional(),
  mine: z.boolean().optional(),
});

export const WhoamiSchema = z.object({});

export const ReadSchema = z.object({
  store_id: StoreIdField,
  path: PathField,
  ref: RefField,
  max_bytes: z.number().int().positive().optional(),
});

export const ListSchema = z.object({
  store_id: StoreIdField,
  path: z.string().optional(),
  ref: RefField,
  recursive: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

export const LogSchema = z.object({
  store_id: StoreIdField,
  ref: RefField,
  path: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const WriteSchema = z.object({
  store_id: StoreIdField,
  path: PathField,
  content_base64: z.string(),
  message: z.string().optional(),
  mode: z.string().optional(),
  ref: RefField,
  idempotency_key: z.string().optional(),
});

export const DeleteSchema = z.object({
  store_id: StoreIdField,
  path: PathField,
  message: z.string().optional(),
  ref: RefField,
  idempotency_key: z.string().optional(),
});

export const TagSchema = z.object({
  store_id: StoreIdField,
  name: z.string().min(1).max(200),
  message: z.string().min(1),
  ref: RefField,
  idempotency_key: z.string().optional(),
});

export const RevertSchema = z.object({
  store_id: StoreIdField,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  ref: RefField,
  subject: z.string().optional(),
  idempotency_key: z.string().optional(),
});

export const MergeSchema = z.object({
  store_id: StoreIdField,
  from_ref: RefField,
  into: z.string().optional(),
  strategy: z.literal('ff-only').optional(),
});
