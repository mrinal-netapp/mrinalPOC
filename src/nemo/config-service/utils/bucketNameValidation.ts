/**
 * Validates S3 bucket names according to AWS S3 naming rules
 * 
 * Rules:
 * - 3-63 characters long
 * - Can contain lowercase letters, numbers, dots (.), and hyphens (-)
 * - Must start and end with a letter or number
 * - Must not be formatted as an IP address (e.g., 192.168.1.1)
 * - Must not start with "xn--" or "sthree-" or "sthree-configur"
 * - Must not end with "-s3alias" or "--ol-s3"
 * - Must not contain consecutive dots (..)
 * - Must not contain uppercase letters
 */

export interface BucketNameValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validates an S3 bucket name
 * @param bucketName - The bucket name to validate
 * @returns Validation result with error message if invalid
 */
export function validateBucketName(bucketName: string): BucketNameValidationResult {
  if (!bucketName || typeof bucketName !== 'string') {
    return {
      valid: false,
      error: 'Bucket name is required'
    }
  }

  const name = bucketName.trim()

  // Check length (3-63 characters)
  if (name.length < 3) {
    return {
      valid: false,
      error: 'Bucket name must be at least 3 characters long'
    }
  }

  if (name.length > 63) {
    return {
      valid: false,
      error: 'Bucket name must be no more than 63 characters long'
    }
  }

  // Check for uppercase letters
  if (name !== name.toLowerCase()) {
    return {
      valid: false,
      error: 'Bucket name must contain only lowercase letters, numbers, dots (.), and hyphens (-)'
    }
  }

  // Check for valid characters (lowercase letters, numbers, dots, hyphens)
  const validPattern = /^[a-z0-9.-]+$/
  if (!validPattern.test(name)) {
    return {
      valid: false,
      error: 'Bucket name can only contain lowercase letters, numbers, dots (.), and hyphens (-)'
    }
  }

  // Must start with a letter or number
  if (!/^[a-z0-9]/.test(name)) {
    return {
      valid: false,
      error: 'Bucket name must start with a letter or number'
    }
  }

  // Must end with a letter or number
  if (!/[a-z0-9]$/.test(name)) {
    return {
      valid: false,
      error: 'Bucket name must end with a letter or number'
    }
  }

  // Must not contain consecutive dots
  if (name.includes('..')) {
    return {
      valid: false,
      error: 'Bucket name cannot contain consecutive dots (..)'
    }
  }

  // Must not be formatted as an IP address (e.g., 192.168.1.1)
  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/
  if (ipPattern.test(name)) {
    return {
      valid: false,
      error: 'Bucket name cannot be formatted as an IP address'
    }
  }

  // Must not start with "xn--" (punycode)
  if (name.startsWith('xn--')) {
    return {
      valid: false,
      error: 'Bucket name cannot start with "xn--"'
    }
  }

  // Must not start with "sthree-" or "sthree-configur"
  if (name.startsWith('sthree-')) {
    return {
      valid: false,
      error: 'Bucket name cannot start with "sthree-"'
    }
  }

  if (name.startsWith('sthree-configur')) {
    return {
      valid: false,
      error: 'Bucket name cannot start with "sthree-configur"'
    }
  }

  // Must not end with "-s3alias"
  if (name.endsWith('-s3alias')) {
    return {
      valid: false,
      error: 'Bucket name cannot end with "-s3alias"'
    }
  }

  // Must not end with "--ol-s3"
  if (name.endsWith('--ol-s3')) {
    return {
      valid: false,
      error: 'Bucket name cannot end with "--ol-s3"'
    }
  }

  return {
    valid: true
  }
}

