/**
 * UUID generation utility
 * Provides a cross-browser compatible UUID v4 generator
 */

/**
 * Generates a UUID v4 string
 * Falls back to a custom implementation if crypto.randomUUID is not available
 */
export function generateUUID(): string {
  // Use native crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  // Fallback implementation for older browsers
  // Generate a UUID v4 compliant string
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

