import { randomBytes } from 'crypto';

/**
 * Generates short, URL-safe dataset IDs
 * Format: dset<8 alphanumeric lowercase characters>
 * 
 * Example: dsetabc123xy
 * Total length: 12 characters (4 for prefix, 8 for random)
 * Entropy: ~41 bits for 8 chars
 * Collision probability: ~0.002% for 10k datasets per project
 */
export class DataSetIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly PREFIX = 'dset';
  private static readonly ID_LENGTH = 8;

  /**
   * Generate a dataset ID in format dset<8 alphanumeric lowercase>
   * @returns Dataset ID (e.g., "dsetabc123xy")
   */
  static generate(): string {
    // Generate enough random bytes for 8 characters
    // Base36: each char represents ~5.17 bits (log2(36))
    // For 8 chars: need ~42 bits = 6 bytes
    const bitsNeeded = this.ID_LENGTH * Math.log2(36);
    const bytesNeeded = Math.ceil(bitsNeeded / 8);
    const bytes = randomBytes(bytesNeeded);

    // Convert to base36 using BigInt for large numbers
    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';

    while (num > 0 && result.length < this.ID_LENGTH) {
      result = this.BASE36[Number(num % 36n)] + result;
      num = num / 36n;
    }

    // Pad with random if needed (shouldn't happen with correct bytesNeeded, but safety check)
    while (result.length < this.ID_LENGTH) {
      const extraByte = randomBytes(1)[0];
      result = this.BASE36[extraByte % 36] + result;
    }

    return this.PREFIX + result;
  }

  /**
   * Validate dataset ID format
   * @param datasetId - ID to validate
   * @returns true if valid format (dset<8 alphanumeric lowercase>)
   */
  static validate(datasetId: string): boolean {
    if (!datasetId || typeof datasetId !== 'string') {
      return false;
    }

    // Must start with "dset" prefix
    if (!datasetId.startsWith(this.PREFIX)) {
      return false;
    }

    // Extract the ID part (after prefix)
    const idPart = datasetId.substring(this.PREFIX.length);

    // Must be exactly 8 characters
    if (idPart.length !== this.ID_LENGTH) {
      return false;
    }

    // Must be base36 (0-9, a-z, lowercase only)
    if (!/^[0-9a-z]+$/.test(idPart)) {
      return false;
    }

    return true;
  }
}
