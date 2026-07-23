import { get_logger } from '@agentstudio/observability-client-runtime';
import {
  KubernetesErrorHandler,
  ErrorContext,
  ErrorDetails,
} from '../KubernetesErrorHandler';

// Mock the observability client so tests don't depend on real logging infra.
// The factory uses jest.fn() which is available even after hoisting.
jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn(),
}));

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

// Configure the mock before any test runs.
(get_logger as jest.Mock).mockReturnValue(mockLogger);

describe('KubernetesErrorHandler', () => {
  describe('extractErrorDetails', () => {
    it('should extract basic error message', () => {
      const error = { message: 'Test error' };
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.message).toBe('Test error');
    });

    it('should extract status code', () => {
      const error = { message: 'Error', statusCode: 404 };
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.statusCode).toBe(404);
    });

    it('should extract error body details', () => {
      const error = {
        message: 'Error',
        body: {
          message: 'API Error',
          reason: 'NotFound',
          details: {
            causes: [{ field: 'name', message: 'Invalid name' }],
            name: 'test-resource',
          },
        },
      };
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.message).toBe('API Error');
      expect(details.reason).toBe('NotFound');
      expect(details.validationErrors).toEqual(['name: Invalid name']);
      expect(details.resourceName).toBe('test-resource');
    });

    it('should extract response body details', () => {
      const error = {
        message: 'Error',
        response: {
          body: {
            message: 'Response Error',
            reason: 'Conflict',
          },
        },
      };
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.message).toBe('Response Error');
      expect(details.reason).toBe('Conflict');
    });

    it('should extract error code', () => {
      const error = { message: 'Error', code: 'ECONNREFUSED' };
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.errorCode).toBe('ECONNREFUSED');
    });

    it('should handle missing message', () => {
      const error = {};
      const details = KubernetesErrorHandler.extractErrorDetails(error);
      expect(details.message).toBe('Unknown error');
    });
  });

  describe('isNotFoundError', () => {
    it('should return true for 404 errors', () => {
      const error = { statusCode: 404 };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return false for non-404 errors', () => {
      const error = { statusCode: 500 };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(false);
    });
  });

  describe('isConflictError', () => {
    it('should return true for 409 errors', () => {
      const error = { statusCode: 409 };
      expect(KubernetesErrorHandler.isConflictError(error)).toBe(true);
    });

    it('should return false for non-409 errors', () => {
      const error = { statusCode: 500 };
      expect(KubernetesErrorHandler.isConflictError(error)).toBe(false);
    });
  });

  describe('isForbiddenError', () => {
    it('should return true for 403 errors', () => {
      const error = { statusCode: 403 };
      expect(KubernetesErrorHandler.isForbiddenError(error)).toBe(true);
    });

    it('should return false for non-403 errors', () => {
      const error = { statusCode: 500 };
      expect(KubernetesErrorHandler.isForbiddenError(error)).toBe(false);
    });
  });

  describe('createEnhancedError', () => {
    it('should create enhanced error with context', () => {
      const error = {
        message: 'Original error',
        statusCode: 404,
      };
      const context: ErrorContext = {
        resourceType: 'TestManager',
        resourceName: 'test-resource',
        operation: 'create',
        namespace: 'test-ns',
      };

      const enhancedError = KubernetesErrorHandler.createEnhancedError(
        error,
        context
      );

      expect(enhancedError).toBeInstanceOf(Error);
      expect(enhancedError.message).toContain('Failed to create test-resource');
      expect(enhancedError.message).toContain('in namespace test-ns');
      expect((enhancedError as any).statusCode).toBe(404);
      expect((enhancedError as any).originalError).toBe(error);
      expect((enhancedError as any).context).toBe(context);
    });

    it('should include error details in message', () => {
      const error = {
        message: 'Original error',
        statusCode: 422,
        body: {
          message: 'Validation failed',
          reason: 'InvalidField',
        },
      };
      const context: ErrorContext = {
        resourceType: 'TestManager',
        resourceName: 'test-resource',
        operation: 'create',
      };

      const enhancedError = KubernetesErrorHandler.createEnhancedError(
        error,
        context
      );

      expect(enhancedError.message).toContain('Validation failed');
      expect(enhancedError.message).toContain('InvalidField');
    });
  });

  describe('logError', () => {
    beforeEach(() => {
      mockLogger.error.mockClear();
      mockLogger.warn.mockClear();
      mockLogger.debug.mockClear();
      mockLogger.info.mockClear();
    });

    it('should log error with context', () => {
      const error = {
        message: 'Test error',
        statusCode: 500,
      };
      const context: ErrorContext = {
        resourceType: 'TestManager',
        resourceName: 'test-resource',
        operation: 'create',
        namespace: 'test-ns',
      };

      KubernetesErrorHandler.logError(context, error);

      expect(mockLogger.error).toHaveBeenCalled();
      const logCall = mockLogger.error.mock.calls[0][0] as string;
      expect(logCall).toContain('TestManager');
      expect(logCall).toContain('create');
      expect(logCall).toContain('test-resource');
      expect(logCall).toContain('test-ns');
    });

    it('should log debug info in debug mode', () => {
      const error = { message: 'Test error', statusCode: 500 };
      const context: ErrorContext = {
        resourceType: 'TestManager',
        resourceName: 'test-resource',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error, 'debug');

      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should provide error hints for 403 errors', () => {
      const error = { message: 'Forbidden', statusCode: 403 };
      const context: ErrorContext = {
        resourceType: 'TestManager',
        resourceName: 'test-resource',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);

      expect(mockLogger.error).toHaveBeenCalledTimes(2); // Error + hint
      const hintCall = mockLogger.error.mock.calls[1][0] as string;
      expect(hintCall).toContain('Permission denied');
      expect(hintCall).toContain('RBAC');
    });

    it('should include API message when different from error message', () => {
      const error = {
        message: 'HTTP error',
        statusCode: 422,
        body: { message: 'Validation failed (different)', reason: 'Invalid' },
      };
      const context: ErrorContext = {
        resourceType: 'StorageClass',
        resourceName: 'sc-1',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);
      const logCall = mockLogger.error.mock.calls[0][0] as string;
      expect(logCall).toContain('Message: Validation failed');
    });

    it('should include validation errors and resource name in log', () => {
      const error = {
        message: 'Validation error',
        statusCode: 422,
        body: {
          message: 'Invalid',
          reason: 'BadRequest',
          details: {
            causes: [{ field: 'spec.provisioner', message: 'Required' }],
            name: 'sc-my-resource',
          },
        },
      };
      const context: ErrorContext = {
        resourceType: 'StorageClass',
        resourceName: 'sc-1',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);
      const logCall = mockLogger.error.mock.calls[0][0] as string;
      expect(logCall).toContain('Validation Errors');
      expect(logCall).toContain('Resource: sc-my-resource');
    });

    it('should provide 422 validation hints for StorageClass', () => {
      const error = { message: 'Validation failed', statusCode: 422 };
      const context: ErrorContext = {
        resourceType: 'StorageClass',
        resourceName: 'sc-1',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);
      const hint = mockLogger.error.mock.calls.find((c: any[]) => 
        (c[0] as string).includes('spec validation failed')
      );
      expect(hint).toBeDefined();
    });

    it('should provide 422 validation hints for PVC', () => {
      const error = { message: 'Validation failed', statusCode: 422 };
      const context: ErrorContext = {
        resourceType: 'PersistentVolumeClaim',
        resourceName: 'pvc-1',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);
      const hint = mockLogger.error.mock.calls.find((c: any[]) => 
        (c[0] as string).includes('spec validation failed')
      );
      expect(hint).toBeDefined();
    });

    it('should provide 404 hint when namespace mentioned in message', () => {
      const error = { message: 'namespace not found', statusCode: 404 };
      const context: ErrorContext = {
        resourceType: 'PVCManager',
        resourceName: 'pvc-1',
        operation: 'create',
        namespace: 'missing-ns',
      };

      KubernetesErrorHandler.logError(context, error);
      const nsHint = mockLogger.error.mock.calls.find((c: any[]) => 
        (c[0] as string).includes('Namespace')
      );
      expect(nsHint).toBeDefined();
    });

    it('should provide 409 hint for conflict errors', () => {
      const error = { message: 'Already exists', statusCode: 409 };
      const context: ErrorContext = {
        resourceType: 'StorageClass',
        resourceName: 'sc-1',
        operation: 'create',
      };

      KubernetesErrorHandler.logError(context, error);
      const warnCall = mockLogger.warn.mock.calls.find((c: any[]) => 
        (c[0] as string).includes('already exists')
      );
      expect(warnCall).toBeDefined();
    });
  });

  describe('isNotFoundError - additional cases', () => {
    it('should return true when response.statusCode is 404', () => {
      const error = { response: { statusCode: 404 } };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return true when body.status is Failure and reason is NotFound', () => {
      const error = { body: { status: 'Failure', reason: 'NotFound' } };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return true when response.body has Failure+NotFound', () => {
      const error = { response: { body: { status: 'Failure', reason: 'NotFound' } } };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return true when message contains "not found"', () => {
      const error = { message: 'Resource not found' };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return true when message contains "NotFound"', () => {
      const error = { message: 'NotFound: resource' };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(true);
    });

    it('should return false when none of the conditions match', () => {
      const error = { message: 'Some other error', statusCode: 500 };
      expect(KubernetesErrorHandler.isNotFoundError(error)).toBe(false);
    });
  });

  describe('createEnhancedError - additional cases', () => {
    it('should include validationErrors, resourceName, errorCode when present', () => {
      const error = {
        message: 'Error',
        statusCode: 422,
        code: 'EVALIDATION',
        body: {
          message: 'Invalid spec',
          reason: 'ValidationError',
          details: {
            causes: [{ field: 'spec.name', message: 'too long' }],
            name: 'my-resource',
          },
        },
      };
      const context: ErrorContext = {
        resourceType: 'StorageClass',
        resourceName: 'sc-1',
        operation: 'create',
        namespace: 'test-ns',
      };

      const enhanced = KubernetesErrorHandler.createEnhancedError(error, context);
      expect(enhanced.message).toContain('Validation Errors');
      expect(enhanced.message).toContain('Resource: my-resource');
      expect(enhanced.message).toContain('Error Code: EVALIDATION');
    });

    it('should handle error without namespace', () => {
      const error = { message: 'Error', statusCode: 500 };
      const context: ErrorContext = {
        resourceType: 'PVManager',
        resourceName: 'pv-1',
        operation: 'delete',
      };

      const enhanced = KubernetesErrorHandler.createEnhancedError(error, context);
      expect(enhanced.message).not.toContain('in namespace');
    });
  });
});

