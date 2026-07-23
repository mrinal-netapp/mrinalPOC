# Storage Manager Refactoring Guide

## Overview

The `Server.ts` file has been refactored to improve clarity, modularity, and maintainability by extracting functionality into focused service modules.

## New Module Structure

### 1. **Types** (`server/types.ts`)
- Extracted all interfaces and types
- `BucketConfig`, `DeploymentConfigResponse`, `BucketRoutingResponse`
- `CachedRoutingInfo`, `NamespaceRoutingEntry`, `BucketListResponse`

### 2. **HttpClient** (`server/services/HttpClient.ts`)
- Centralized HTTP request handling
- Handles both HTTP and HTTPS
- Includes debug logging
- Reusable across all services

### 3. **RoutingManager** (`server/services/RoutingManager.ts`)
- Manages routing information queries
- Handles routing cache and namespace routing registry
- Syncs routing info for all buckets in relevant namespaces
- Provides routing info lookup with fallback strategies

### 4. **ConfigSyncManager** (`server/services/ConfigSyncManager.ts`)
- Handles configuration synchronization from namespace service
- Detects bucket changes (added/removed/changed)
- Manages config version tracking
- Coordinates with RoutingManager for namespace-wide sync

## Refactoring Benefits

1. **Single Responsibility**: Each module has a clear, focused purpose
2. **Testability**: Modules can be tested independently
3. **Maintainability**: Changes to one area don't affect others
4. **Reusability**: Services can be reused or extended easily
5. **Clarity**: Code organization makes it easier to understand

## Next Steps

The following modules should be created to complete the refactoring:

1. **HealthReporter** - Extract health reporting logic
2. **DeploymentRegistrar** - Extract deployment registration logic
3. **Update Server.ts** - Refactor main Server class to use all modules

## Usage Example

```typescript
// Before (monolithic)
private async getRoutingInfo(...) {
  // 200+ lines of routing logic
}

// After (modular)
const routingInfo = await this.routingManager.getRoutingInfo(
  bucketName,
  namespaceId,
  this.bucketRegistry
);
```

## Migration Path

1. ✅ Extract types to `types.ts`
2. ✅ Create `HttpClient` service
3. ✅ Create `RoutingManager` service
4. ✅ Create `ConfigSyncManager` service
5. ⏳ Create `HealthReporter` service
6. ⏳ Create `DeploymentRegistrar` service
7. ⏳ Refactor `Server.ts` to use all modules

