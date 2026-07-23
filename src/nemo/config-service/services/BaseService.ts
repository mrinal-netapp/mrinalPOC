/**
 * Base service class for common service patterns
 * Provides utilities for validation, error handling, and common operations
 */
export abstract class BaseService {
  /**
   * Validate that a required value exists
   */
  protected validateRequired<T>(value: T | null | undefined, fieldName: string): T {
    if (value === null || value === undefined) {
      throw new Error(`${fieldName} is required`);
    }
    return value;
  }

  /**
   * Validate that an entity exists
   */
  protected async validateEntityExists<T>(
    findFn: () => Promise<T | null>,
    entityName: string,
    identifier: string
  ): Promise<T> {
    const entity = await findFn();
    if (!entity) {
      throw new Error(`${entityName} with identifier ${identifier} not found`);
    }
    return entity;
  }

  /**
   * Validate business rule
   */
  protected validateBusinessRule(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(message);
    }
  }

  /**
   * Handle async operations with error wrapping
   */
  protected async executeWithErrorHandling<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`${errorMessage}: ${error.message}`);
      }
      throw new Error(errorMessage);
    }
  }
}

