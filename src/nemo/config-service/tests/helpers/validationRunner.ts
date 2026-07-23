/**
 * Run express-validator chains against a synthetic request (no HTTP / DB).
 */
import { validationResult, type ValidationChain } from 'express-validator';

export type SyntheticRequest = {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

export async function runValidators(
  chains: ValidationChain[],
  input: SyntheticRequest = {},
) {
  const req = {
    body: input.body ?? {},
    query: input.query ?? {},
    params: input.params ?? {},
  };
  for (const chain of chains) {
    await chain.run(req);
  }
  return validationResult(req);
}

export function validationMessages(result: ReturnType<typeof validationResult>): string {
  return result
    .array()
    .map((e) => e.msg)
    .join('; ');
}
