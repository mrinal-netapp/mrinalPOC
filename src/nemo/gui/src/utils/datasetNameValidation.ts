/**
 * Validates dataset names to ensure they are valid table identifiers for Lakekeeper/Iceberg
 * 
 * Rules for valid table names:
 * - 1-255 characters long (Iceberg standard)
 * - Can contain lowercase letters, numbers, underscores (_), and hyphens (-)
 * - Must start with a letter or underscore
 * - Must not contain spaces or special characters
 * - Should be URL-safe
 */

export interface DatasetNameValidationResult {
  valid: boolean
  error?: string
  sanitized?: string // Sanitized version if original is invalid
}

/**
 * Validates a dataset name for use as a Lakekeeper table identifier
 * @param datasetName - The dataset name to validate
 * @returns Validation result with error message if invalid, and optionally a sanitized version
 */
export function validateDatasetName(datasetName: string): DatasetNameValidationResult {
  if (!datasetName || typeof datasetName !== 'string') {
    return {
      valid: false,
      error: 'Dataset name is required'
    }
  }

  const name = datasetName.trim()

  // Check length (1-255 characters)
  if (name.length < 1) {
    return {
      valid: false,
      error: 'Dataset name must be at least 1 character long'
    }
  }

  if (name.length > 255) {
    return {
      valid: false,
      error: 'Dataset name must be no more than 255 characters long'
    }
  }

  // Must start with a letter or underscore
  if (!/^[a-z_]/.test(name)) {
    return {
      valid: false,
      error: 'Dataset name must start with a letter (a-z) or underscore (_)'
    }
  }

  // Check for valid characters (lowercase letters, numbers, underscores, hyphens)
  const validPattern = /^[a-z0-9_-]+$/
  if (!validPattern.test(name)) {
    // Generate sanitized version
    let sanitized = name.toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_') // Replace invalid chars with underscore
      .replace(/^[^a-z_]/, '_') // Ensure starts with letter or underscore
      .replace(/_+/g, '_') // Collapse multiple underscores
      .replace(/^_+|_+$/g, '') // Remove leading/trailing underscores
    
    // Ensure it starts with a letter or underscore
    if (!/^[a-z_]/.test(sanitized)) {
      sanitized = 'dataset_' + sanitized
    }
    
    return {
      valid: false,
      error: 'Dataset name can only contain lowercase letters (a-z), numbers (0-9), underscores (_), and hyphens (-)',
      sanitized: sanitized || 'dataset'
    }
  }

  // Check for SQL reserved words (basic check - can be expanded)
  const reservedWords = ['table', 'select', 'insert', 'update', 'delete', 'create', 'drop', 'alter', 'index', 'view']
  if (reservedWords.includes(name.toLowerCase())) {
    return {
      valid: false,
      error: `Dataset name cannot be a reserved word: ${name}. Please use a different name.`
    }
  }

  return {
    valid: true
  }
}

/**
 * Validates dataset name and returns error message for display
 * @param datasetName - The dataset name to validate
 * @returns Error message string if invalid, undefined if valid
 */
export function getDatasetNameError(datasetName: string): string | undefined {
  const result = validateDatasetName(datasetName)
  return result.valid ? undefined : result.error
}
