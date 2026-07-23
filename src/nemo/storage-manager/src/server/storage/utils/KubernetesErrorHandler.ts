import { get_logger } from '@agentstudio/observability-client-runtime';
/**
 * Centralized error handling for Kubernetes API operations
 * Provides consistent error extraction, logging, and user-friendly messages
 */

export interface ErrorContext {
  resourceType: string;
  resourceName: string;
  operation: string;
  namespace?: string;
  additionalInfo?: Record<string, any>;
}

export interface ErrorDetails {
  statusCode?: number;
  message: string;
  reason?: string;
  validationErrors?: string[];
  resourceName?: string;
  errorCode?: string;
}

export class KubernetesErrorHandler {
  /**
   * Extract detailed error information from Kubernetes API error
   */
  static extractErrorDetails(error: any): ErrorDetails {
    const details: ErrorDetails = {
      message: error.message || 'Unknown error',
    };

    if (error.statusCode) {
      details.statusCode = error.statusCode;
    }

    // Check error.body (common in @kubernetes/client-node)
    if (error.body) {
      if (error.body.message) {
        details.message = error.body.message;
      }
      if (error.body.reason) {
        details.reason = error.body.reason;
      }
      if (error.body.details) {
        if (error.body.details.causes) {
          details.validationErrors = error.body.details.causes.map((c: any) =>
            `${c.field}: ${c.message}`
          );
        }
        if (error.body.details.name) {
          details.resourceName = error.body.details.name;
        }
      }
    }

    // Check response.body (alternative format)
    if (error.response?.body) {
      const body = error.response.body;
      if (body.message && !details.message.includes(body.message)) {
        details.message = body.message;
      }
      if (body.reason && !details.reason) {
        details.reason = body.reason;
      }
    }

    if (error.code) {
      details.errorCode = error.code;
    }

    return details;
  }

  /**
   * Log Kubernetes error with context and details
   */
  static logError(
    context: ErrorContext,
    error: any,
    logLevel: string = 'info'
  ): void {
    const logger = get_logger();
    const details = this.extractErrorDetails(error);
    const errorDetails: string[] = [];

    if (details.statusCode) {
      errorDetails.push(`Status: ${details.statusCode}`);
    }
    if (details.message && details.message !== error.message) {
      errorDetails.push(`Message: ${details.message}`);
    }
    if (details.reason) {
      errorDetails.push(`Reason: ${details.reason}`);
    }
    if (details.validationErrors) {
      errorDetails.push(`Validation Errors: ${details.validationErrors.join('; ')}`);
    }
    if (details.resourceName) {
      errorDetails.push(`Resource: ${details.resourceName}`);
    }

    const errorMsg = errorDetails.length > 0
      ? `${error.message} (${errorDetails.join(', ')})`
      : error.message;

    logger.error(
      `[${context.resourceType}] Failed to ${context.operation} ${context.resourceName}` +
      (context.namespace ? ` in namespace ${context.namespace}` : '') +
      `: ${errorMsg}`
    );

    // Log full error in debug mode
    if (logLevel === 'debug') {
      logger.debug(
        `[${context.resourceType}] Full error object:`,
        JSON.stringify(error, null, 2).substring(0, 1000)
      );
    }

    // Provide helpful hints for common errors
    this.provideErrorHints(details.statusCode, context, error);
  }

  /**
   * Provide helpful hints for common Kubernetes errors
   */
  private static provideErrorHints(
    statusCode: number | undefined,
    context: ErrorContext,
    error: any
  ): void {
    if (!statusCode) return;

    const logger = get_logger();
    const resourceType = context.resourceType.toLowerCase();

    switch (statusCode) {
      case 403:
        logger.error(
          `[${context.resourceType}] Permission denied. Ensure ServiceAccount has '${context.operation}' permission ` +
          `on '${this.getResourcePlural(resourceType)}' resource. Check RBAC configuration.`
        );
        break;

      case 422:
        const validationHints = this.getValidationHints(resourceType, context);
        logger.error(
          `[${context.resourceType}] ${resourceType} spec validation failed. Check: ${validationHints}`
        );
        break;

      case 404:
        if (error.message?.includes('namespace')) {
          logger.error(
            `[${context.resourceType}] Namespace '${context.namespace}' not found. ` +
            `Verify namespace exists and Storage Manager has access to it.`
          );
        }
        break;

      case 409:
        logger.warn(
          `[${context.resourceType}] ${context.resourceName} already exists (race condition). This is usually harmless.`
        );
        break;
    }
  }

  /**
   * Get validation hints for specific resource types
   */
  private static getValidationHints(
    resourceType: string,
    context: ErrorContext
  ): string {
    const hints: string[] = [];

    switch (resourceType) {
      case 'storageclass':
        hints.push(
          `- StorageClass name '${context.resourceName}' is valid (RFC 1123 subdomain, max 253 chars)`,
          `- Provisioner 'kubernetes.io/no-provisioner' is valid`,
          `- Parameters are correctly formatted (empty for static provisioning)`
        );
        break;

      case 'persistentvolumeclaim':
      case 'pvc':
        hints.push(
          `- StorageClass exists and is valid`,
          `- Storage size is valid`,
          `- Access mode 'ReadWriteMany' is supported by StorageClass`
        );
        break;
    }

    return hints.join(', ');
  }

  /**
   * Get plural form of resource type for RBAC messages
   */
  private static getResourcePlural(resourceType: string): string {
    const plurals: Record<string, string> = {
      storageclass: 'storageclasses',
      persistentvolumeclaim: 'persistentvolumeclaims',
      pvc: 'persistentvolumeclaims',
      secret: 'secrets',
      persistentvolume: 'persistentvolumes',
      pv: 'persistentvolumes',
      deployment: 'deployments',
    };

    return plurals[resourceType.toLowerCase()] || `${resourceType}s`;
  }

  /**
   * Create an enhanced error with context and original error
   */
  static createEnhancedError(
    error: any,
    context: ErrorContext
  ): Error {
    const details = this.extractErrorDetails(error);
    const errorDetails: string[] = [];

    errorDetails.push(`Status: ${details.statusCode || 'unknown'}`);
    if (details.message && details.message !== error.message) {
      errorDetails.push(`API Message: ${details.message}`);
    }
    if (details.reason) {
      errorDetails.push(`Reason: ${details.reason}`);
    }
    if (details.validationErrors) {
      errorDetails.push(`Validation Errors: ${details.validationErrors.join('; ')}`);
    }
    if (details.resourceName) {
      errorDetails.push(`Resource: ${details.resourceName}`);
    }
    if (details.errorCode) {
      errorDetails.push(`Error Code: ${details.errorCode}`);
    }

    const fullErrorMsg =
      `Failed to ${context.operation} ${context.resourceName}` +
      (context.namespace ? ` in namespace ${context.namespace}` : '') +
      `: ${details.message}${details.reason ? ` (${details.reason})` : ''}` +
      (errorDetails.length > 1 ? ` | ${errorDetails.join(', ')}` : '');

    const enhancedError = new Error(fullErrorMsg);
    (enhancedError as any).statusCode = details.statusCode;
    (enhancedError as any).originalError = error;
    (enhancedError as any).context = context;

    return enhancedError;
  }

  /**
   * Check if error is a 404 (not found)
   * Handles multiple error formats from @kubernetes/client-node
   */
  static isNotFoundError(error: any): boolean {
    // Check statusCode directly
    if (error.statusCode === 404) {
      return true;
    }
    
    // Check response.statusCode
    if (error.response?.statusCode === 404) {
      return true;
    }
    
    // Check body.status and reason
    if (error.body?.status === 'Failure' && error.body?.reason === 'NotFound') {
      return true;
    }
    
    // Check response.body
    if (error.response?.body?.status === 'Failure' && error.response?.body?.reason === 'NotFound') {
      return true;
    }
    
    // Check error message for common 404 indicators
    const message = error.message || error.body?.message || '';
    if (message.includes('not found') || message.includes('NotFound')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if error is a 409 (conflict/already exists)
   */
  static isConflictError(error: any): boolean {
    return error.statusCode === 409;
  }

  /**
   * Check if error is a 403 (forbidden)
   */
  static isForbiddenError(error: any): boolean {
    return error.statusCode === 403;
  }
}

