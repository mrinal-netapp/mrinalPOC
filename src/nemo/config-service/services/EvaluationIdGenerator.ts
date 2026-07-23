import { randomBytes } from 'crypto';

/**
 * Generates short, URL-safe IDs for the Evaluations feature.
 *
 *   - templates:  evt-<8 lowercase alphanumeric>   (e.g. evt-abc123xy)
 *
 * Evaluation *runs* use UUIDs (see EvaluationRun), matching the design's
 * `runId: UUID` + `workflowId = evaluation-agent-run-${runId}` convention.
 *
 * Test cases carry author-supplied `id` strings inside the JSONL rows on
 * the data plane and do not get an id minted here.
 */
export class EvaluationIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly TEMPLATE_PREFIX = 'evt-';
  private static readonly ID_LENGTH = 8;

  // Largest multiple of 36 that fits in a byte (36 * 7 = 252). Bytes >= this
  // are rejected so `byte % 36` is uniform (no modulo bias from a CSPRNG).
  private static readonly REJECTION_THRESHOLD = 252;

  private static randomSuffix(): string {
    let result = '';
    while (result.length < this.ID_LENGTH) {
      const bytes = randomBytes(this.ID_LENGTH);
      for (let i = 0; i < bytes.length && result.length < this.ID_LENGTH; i++) {
        const b = bytes[i];
        if (b < this.REJECTION_THRESHOLD) {
          result += this.BASE36[b % 36];
        }
      }
    }
    return result;
  }

  static template(): string {
    return this.TEMPLATE_PREFIX + this.randomSuffix();
  }

  static validateTemplate(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    if (!id.startsWith(this.TEMPLATE_PREFIX)) return false;
    const idPart = id.substring(this.TEMPLATE_PREFIX.length);
    if (idPart.length !== this.ID_LENGTH) return false;
    return /^[0-9a-z]+$/.test(idPart);
  }
}
