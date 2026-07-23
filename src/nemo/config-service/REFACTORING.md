# Config Service Refactoring

This document describes the refactoring improvements made to the config-service for better modularity, maintainability, and testability.

## Overview

The refactoring focuses on:
1. **Modularity**: Separating concerns into distinct layers
2. **Common Patterns**: Consolidating similar code into reusable components
3. **Extensibility**: Making it easier to add new features
4. **Testability**: Improving dependency injection and mocking capabilities

## Key Changes

### 1. Base Repository Pattern (`repositories/BaseRepository.ts`)

Created a base repository class that provides common CRUD operations:
- `create()`, `getById()`, `update()`, `delete()`, `list()`, `exists()`
- Abstract methods for entity-to-model mapping
- Reduces code duplication across repositories

**Benefits:**
- Consistent API across all repositories
- Easier to add new repositories
- Centralized error handling patterns

### 2. Repository Factory (`repositories/RepositoryFactory.ts`)

Centralized repository management with dependency injection:
- Singleton pattern for repository instances
- Lazy initialization
- Easy to mock for testing

**Benefits:**
- Single source of truth for repositories
- Better testability (can inject mock repositories)
- Prevents multiple repository instances

### 3. Custom Error Classes (`utils/errors.ts`)

Type-safe error classes:
- `NotFoundError` (404)
- `ValidationError` (400)
- `ConflictError` (409)
- `BusinessLogicError` (400)

**Benefits:**
- Better error handling
- Automatic HTTP status code mapping
- Type-safe error checking

### 4. Route Handler Utilities (`utils/routeHandler.ts`)

Common route handler patterns:
- `asyncHandler()` - Wraps async routes with error handling
- `validateRequest()` - Validates express-validator results
- `sendSuccess()` / `sendError()` - Consistent response formatting
- `createCrudHandlers()` - Factory for standard CRUD routes

**Benefits:**
- Reduces boilerplate in routes
- Consistent error handling
- Easier to add new routes

### 5. Base Service Class (`services/BaseService.ts`)

Common service utilities:
- `validateRequired()` - Validates required fields
- `validateEntityExists()` - Validates entity existence
- `validateBusinessRule()` - Validates business rules
- `executeWithErrorHandling()` - Wraps operations with error handling

**Benefits:**
- Consistent validation patterns
- Reusable business logic utilities
- Better error messages

### 6. Error Handling Middleware (`middleware/errorHandler.ts`)

Global error handling:
- Catches all unhandled errors
- Maps errors to appropriate HTTP status codes
- Logs errors for debugging
- 404 handler for unmatched routes

**Benefits:**
- Centralized error handling
- Consistent error responses
- Better debugging with error logging

## Migration Guide

### Updating Routes

**Before:**
```typescript
router.get('/:id', async (req, res) => {
  try {
    const repo = AppDataSource.getRepository(Model);
    const item = await repo.findOne({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
```

**After:**
```typescript
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import { NotFoundError } from '../utils/errors';

router.get('/:id', asyncHandler(async (req, res) => {
  const item = await modelService.getById(req.params.id);
  if (!item) {
    return sendError(res, new NotFoundError('Model', req.params.id));
  }
  sendSuccess(res, item);
}));
```

### Updating Services

**Before:**
```typescript
export class MyService {
  static async getItem(id: string) {
    const item = await repo.findOne({ where: { id } });
    if (!item) {
      throw new Error(`Item ${id} not found`);
    }
    return item;
  }
}
```

**After:**
```typescript
import { BaseService } from './BaseService';
import { NotFoundError } from '../utils/errors';

export class MyService extends BaseService {
  static async getItem(id: string) {
    return await this.validateEntityExists(
      () => repo.findOne({ where: { id } }),
      'Item',
      id
    );
  }
}
```

### Updating Repositories

Repositories can now extend `BaseRepository` for common operations, or use the factory pattern:

```typescript
import { BaseRepository } from './BaseRepository';

export class MyRepository extends BaseRepository<MyEntity, MyModel> {
  constructor(dataSource: DataSource) {
    super(dataSource, MyEntity);
  }

  protected mapEntityToModel(entity: MyEntity): MyModel {
    // Implementation
  }

  protected mapModelToEntity(model: Partial<MyModel>): Partial<MyEntity> {
    // Implementation
  }

  protected getEntityName(): string {
    return 'MyEntity';
  }
}
```

## Testing Improvements

### Mocking Repositories

```typescript
import { getRepositoryFactory } from '../repositories/RepositoryFactory';

// In tests
const mockFactory = {
  deploymentRepo: mockDeploymentRepo,
  // ... other repos
};

jest.mock('../repositories/RepositoryFactory', () => ({
  getRepositoryFactory: () => mockFactory,
}));
```

### Testing Services

Services can now be easily tested with mocked dependencies:

```typescript
import { ManifestService } from '../services/ManifestService';

describe('ManifestService', () => {
  it('should throw NotFoundError when dataset not found', async () => {
    // Mock repository
    // Test error handling
  });
});
```

## Future Improvements

1. **Service Layer**: Extract more business logic from routes into services
2. **Repository Extensions**: Refactor existing repositories to extend BaseRepository
3. **Validation Layer**: Create a centralized validation service
4. **Event System**: Add event-driven architecture for cross-cutting concerns
5. **Caching Layer**: Add caching utilities for frequently accessed data

## Benefits Summary

- **Modularity**: Clear separation of concerns
- **Maintainability**: Less code duplication, easier to understand
- **Extensibility**: Easy to add new features following established patterns
- **Testability**: Better dependency injection and mocking capabilities
- **Consistency**: Uniform patterns across the codebase

