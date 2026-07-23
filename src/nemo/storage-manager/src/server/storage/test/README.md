# Storage Module Tests

This directory contains unit tests for the storage management modules.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Test Structure

Tests are organized by module type:

- **utils/** - Tests for utility modules (NameGenerator, EndpointParser, KubernetesErrorHandler)
- **builders/** - Tests for builder modules (SecretBuilder, StorageClassBuilder, PVBuilder, PVCBuilder)
- **managers/** - Tests for manager modules (SecretManager, PVManager, etc.)

## Test Coverage

### Utility Modules
- ✅ NameGenerator - Name generation and sanitization
- ✅ EndpointParser - Endpoint parsing for NFS/SMB
- ✅ KubernetesErrorHandler - Error handling and logging

### Builder Modules
- ✅ SecretBuilder - Secret spec building
- ✅ StorageClassBuilder - StorageClass spec building
- ✅ PVBuilder - PersistentVolume spec building
- ✅ PVCBuilder - PersistentVolumeClaim spec building

### Manager Modules
- ✅ SecretManager - Secret CRUD operations
- ✅ PVManager - PV lifecycle management

## Writing New Tests

When adding new functionality:

1. Create test file: `__tests__/ModuleName.test.ts`
2. Follow existing patterns for mocking Kubernetes APIs
3. Test both success and error cases
4. Include edge cases and boundary conditions

## Mocking Kubernetes APIs

Manager tests use Jest mocks for Kubernetes API clients:

```typescript
const mockCoreApi = {
  readNamespacedSecret: jest.fn(),
  createNamespacedSecret: jest.fn(),
} as any;
```

## Example Test

```typescript
describe('MyModule', () => {
  beforeEach(() => {
    // Setup mocks
  });

  it('should do something', () => {
    // Test implementation
  });
});
```

