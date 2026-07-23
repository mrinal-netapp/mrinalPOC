# Service Layer Opportunities

This document analyzes opportunities to create services for entities similar to `ManifestService` and the advantages they provide.

## Current State Analysis

### Entities with Complex Business Logic (High Priority)

#### 1. **DataSetService** ⭐⭐⭐ (HIGHEST PRIORITY)
**Current Issues:**
- Complex business logic in routes (150+ lines in POST handler)
- Manifest creation/update logic mixed with dataset operations
- Complex filtering and pagination logic
- History/versioning operations
- Restore operations
- Validation logic (type/kind/bucket immutability)

**Benefits of Service:**
- ✅ Centralize dataset + manifest coordination
- ✅ Reusable business logic for dataset operations
- ✅ Better testability (can mock repositories)
- ✅ Consistent error handling
- ✅ Easier to add features (e.g., dataset validation, lifecycle management)

**Complex Operations to Extract:**
- `createDataSet()` - Creates dataset + manifest + commits manifest
- `updateDataSet()` - Updates dataset + handles manifest updates + validates immutability
- `deleteDataSet()` - Deletes dataset + all manifests
- `listDataSets()` - Complex filtering, pagination, manifest inclusion
- `restoreDataSetVersion()` - History restoration with manifest recreation
- `validateDataSetUpdate()` - Business rule validation

#### 2. **DeploymentService** ⭐⭐⭐ (HIGH PRIORITY)
**Current Issues:**
- Complex bucket assignment logic
- Routing calculation logic
- Health check coordination
- Re-registration handling
- Bucket reassignment on deployment changes

**Benefits of Service:**
- ✅ Centralize deployment + bucket assignment coordination
- ✅ Reusable routing logic
- ✅ Better testability for complex assignment algorithms
- ✅ Easier to add deployment lifecycle management

**Complex Operations to Extract:**
- `registerDeployment()` - Registration + bucket assignment
- `updateDeployment()` - Update + bucket reassignment
- `getBucketRouting()` - Calculate routing for buckets
- `reassignBucketsForDeployment()` - Bucket assignment logic
- `getDeploymentConfig()` - Configuration distribution

#### 3. **SearchService** ⭐⭐ (MEDIUM PRIORITY)
**Current Issues:**
- Search logic duplicated across entities
- No centralized search interface
- Hard to extend to new entity types

**Benefits of Service:**
- ✅ Unified search interface
- ✅ Easy to add new entity types
- ✅ Consistent search behavior
- ✅ Better testability

**Complex Operations to Extract:**
- `searchEntities()` - Generic search across entity types
- `searchConnectors()` - Connector-specific search
- `searchDataSets()` - Dataset-specific search
- `buildSearchQuery()` - Query builder utilities

### Entities with Moderate Complexity (Medium Priority)

#### 4. **ConnectorService** ⭐⭐
**Current Issues:**
- Complex JSONB filtering logic
- Name regex filtering
- Field validation for filtering

**Benefits:**
- ✅ Centralize filtering logic
- ✅ Reusable query building
- ✅ Better testability

#### 5. **BucketService** ⭐⭐
**Current Issues:**
- Bucket validation logic
- Routing coordination
- Health check integration

**Benefits:**
- ✅ Centralize bucket operations
- ✅ Coordinate with deployment routing
- ✅ Better validation

### Entities with Simple CRUD (Lower Priority)

#### 6. **ModelService, KnowledgeBaseService, PipelineService, ToolService** ⭐
**Current State:** Simple CRUD operations

**Benefits:**
- ✅ Consistency across all entities
- ✅ Future-proofing (easier to add business logic later)
- ✅ Standardized error handling
- ✅ Better testability

## Advantages of Service Layer

### 1. **Separation of Concerns**
- **Routes**: Handle HTTP concerns (request/response, validation)
- **Services**: Handle business logic
- **Repositories**: Handle data access

### 2. **Reusability**
- Business logic can be reused across different entry points (REST API, CLI, background jobs)
- Services can call other services (e.g., DataSetService uses ManifestService)

### 3. **Testability**
- Services can be unit tested without HTTP layer
- Easy to mock dependencies
- Test business logic in isolation

### 4. **Maintainability**
- Business logic changes don't require route changes
- Easier to understand and modify
- Centralized error handling

### 5. **Extensibility**
- Easy to add new features (e.g., dataset validation, lifecycle hooks)
- Can add cross-cutting concerns (logging, caching, events)
- Easier to add new entry points (GraphQL, gRPC)

### 6. **Consistency**
- Uniform patterns across all entities
- Consistent error handling
- Standardized validation

## Implementation Priority

### Phase 1: High-Value Services
1. **DataSetService** - Most complex, highest value
2. **DeploymentService** - Complex routing logic

### Phase 2: Medium-Value Services
3. **SearchService** - Unify search logic
4. **ConnectorService** - Complex filtering

### Phase 3: Consistency Services
5. **BucketService** - Coordinate with deployments
6. **ModelService, KnowledgeBaseService, etc.** - Standardize all entities

## Example: DataSetService Structure

```typescript
export class DataSetService extends BaseService {
  // Core CRUD
  static async createDataSet(data: CreateDataSetRequest): Promise<DataSet>
  static async getDataSet(id: string): Promise<DataSet>
  static async updateDataSet(id: string, data: UpdateDataSetRequest): Promise<DataSet>
  static async deleteDataSet(id: string): Promise<void>
  static async listDataSets(options: ListOptions): Promise<DataSet[]>
  
  // Business Logic
  static async createDataSetWithFiles(data: CreateDataSetRequest, files: FileInfo[]): Promise<DataSet>
  static async updateDataSetWithFiles(id: string, data: UpdateDataSetRequest, files?: FileInfo[]): Promise<DataSet>
  static async validateDataSetUpdate(id: string, updates: UpdateDataSetRequest): Promise<void>
  static async restoreDataSetVersion(id: string, version: number): Promise<DataSet>
  
  // Query Operations
  static async searchDataSets(query: SearchQuery): Promise<DataSet[]>
  static async getDataSetHistory(id: string): Promise<DataSetHistory[]>
}
```

## Migration Strategy

1. **Create service alongside existing route logic** (non-breaking)
2. **Gradually migrate route handlers to use service**
3. **Add tests for service layer**
4. **Remove duplicate logic from routes**
5. **Refactor routes to be thin wrappers around services**

