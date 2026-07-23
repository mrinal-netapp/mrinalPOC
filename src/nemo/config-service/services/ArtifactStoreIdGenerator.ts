import { randomBytes } from 'crypto';

/**
 * Generates short, URL-safe artifact store IDs.
 * Format: as<8 alphanumeric lowercase characters>
 *
 * Example: asabc123xy
 * Total length: 10 characters (2 for prefix, 8 for random)
 * Entropy: ~41 bits for 8 chars
 * Collision probability: ~0.002% for 10k stores per project
 */
export class ArtifactStoreIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly PREFIX = 'as';
  private static readonly ID_LENGTH = 8;

  static generate(): string {
    // 36^8 needs ~41.4 bits. We allocate 16 random bytes (128 bits) so
    // the BigInt is guaranteed to be large enough to produce ID_LENGTH
    // base36 characters via the unbiased div/mod loop below; the
    // previous "fallback byte % 36" loop was a modulo-bias hazard that
    // CodeQL flagged. With 16 bytes the fallback is unreachable and we
    // throw if invariant is somehow violated.
    const RANDOM_BYTES = 16;
    const bytes = randomBytes(RANDOM_BYTES);

    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';

    while (num > 0n && result.length < this.ID_LENGTH) {
      result = this.BASE36[Number(num % 36n)] + result;
      num = num / 36n;
    }

    // 128 random bits produce 8 base36 chars in all but ~2^-91 of
    // outcomes (when the BigInt < 36^7 ≈ 7.84e10). On that astronomical
    // tail, pad with leading '0' instead of throwing — the result stays
    // unbiased across the 36^8 id space (just with leading-0 ids in the
    // tail) and store creation never 500s.
    while (result.length < this.ID_LENGTH) {
      result = '0' + result;
    }

    return this.PREFIX + result;
  }

  static validate(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    if (!id.startsWith(this.PREFIX)) return false;
    const idPart = id.substring(this.PREFIX.length);
    if (idPart.length !== this.ID_LENGTH) return false;
    return /^[0-9a-z]+$/.test(idPart);
  }
}
