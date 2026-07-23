import { randomBytes } from 'crypto';

/**
 * Generates short, URL-safe workspace IDs for subdomain routing
 * Format: Base36 (0-9, a-z), 10 characters, lowercase only
 * 
 * Entropy: ~51 bits for 10 chars
 * Collision probability: < 0.2% for 1M workspaces
 */
export class WorkspaceIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly DEFAULT_LENGTH = 10;
  private static readonly MIN_LENGTH = 8;
  private static readonly MAX_LENGTH = 12;

  /**
   * Generate a short workspace ID
   * @param length - Desired length (8-12, default 10)
   * @returns Base36 encoded workspace ID (lowercase alphanumeric)
   */
  static generate(length: number = this.DEFAULT_LENGTH): string {
    if (length < this.MIN_LENGTH || length > this.MAX_LENGTH) {
      throw new Error(`Workspace ID length must be between ${this.MIN_LENGTH} and ${this.MAX_LENGTH}`);
    }

    // Generate enough random bytes for desired entropy
    // Base36: each char represents ~5.17 bits (log2(36))
    // For 10 chars: need ~52 bits = 7 bytes
    // For 12 chars: need ~62 bits = 8 bytes
    const bitsNeeded = length * Math.log2(36);
    const bytesNeeded = Math.ceil(bitsNeeded / 8);
    const bytes = randomBytes(bytesNeeded);

    // Convert to base36 using BigInt for large numbers
    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';

    while (num > 0 && result.length < length) {
      result = this.BASE36[Number(num % 36n)] + result;
      num = num / 36n;
    }

    // Pad with random if needed (shouldn't happen with correct bytesNeeded, but safety check)
    while (result.length < length) {
      const extraByte = randomBytes(1)[0];
      result = this.BASE36[extraByte % 36] + result;
    }

    return result;
  }

  /**
   * Validate workspace ID format
   * @param workspaceId - ID to validate
   * @returns true if valid base36 format (8-12 chars, lowercase alphanumeric)
   */
  static validate(workspaceId: string): boolean {
    if (!workspaceId || typeof workspaceId !== 'string') {
      return false;
    }

    // Must be base36 (0-9, a-z, lowercase only)
    if (!/^[0-9a-z]+$/.test(workspaceId)) {
      return false;
    }

    // Length check
    if (workspaceId.length < this.MIN_LENGTH || workspaceId.length > this.MAX_LENGTH) {
      return false;
    }

    return true;
  }
}

