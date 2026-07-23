import { QueryFailedError } from 'typeorm';

/** PostgreSQL unique_violation — e.g. duplicate (projectId, name). */
export function isPostgresUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505'
  );
}
