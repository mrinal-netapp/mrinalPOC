import { randomBytes } from 'crypto';

/**
 * Generates short, URL-safe volume IDs
 * Format: vol-<8 alphanumeric lowercase characters>
 *
 * Example: vol-b3x9k2p4
 * Total length: 12 characters (4 for prefix, 8 for random)
 */
export class VolumeIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly PREFIX = 'vol-';
  private static readonly ID_LENGTH = 8;

  static generate(): string {
    const bitsNeeded = this.ID_LENGTH * Math.log2(36);
    const bytesNeeded = Math.ceil(bitsNeeded / 8);
    const bytes = randomBytes(bytesNeeded);

    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';

    while (num > 0 && result.length < this.ID_LENGTH) {
      result = this.BASE36[Number(num % 36n)] + result;
      num = num / 36n;
    }

    while (result.length < this.ID_LENGTH) {
      const extraByte = randomBytes(1)[0];
      result = this.BASE36[extraByte % 36] + result;
    }

    return this.PREFIX + result;
  }

  static validate(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    if (!id.startsWith(this.PREFIX)) return false;
    const idPart = id.substring(this.PREFIX.length);
    if (idPart.length !== this.ID_LENGTH) return false;
    if (!/^[0-9a-z]+$/.test(idPart)) return false;
    return true;
  }
}
