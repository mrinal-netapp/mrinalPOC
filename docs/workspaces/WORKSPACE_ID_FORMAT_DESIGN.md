# Workspace ID Format Design

## Document Information
- **Version**: 1.0
- **Date**: 12/30/2025
- **Status**: Design Phase
- **Author**: Ramesh Sekaran (ramesh.sekaran@netapp.com)

---

## Table of Contents
1. [Current Implementation](#current-implementation)
2. [Problem Statement](#problem-statement)
3. [Requirements](#requirements)
4. [Proposed Solution](#proposed-solution)
5. [Entropy Analysis](#entropy-analysis)
6. [Implementation Approach](#implementation-approach)
7. [Migration Strategy](#migration-strategy)
8. [Testing Considerations](#testing-considerations)

---

## Current Implementation

### Current Format: UUID v4

Workspace IDs are currently generated using **UUID v4** (Universally Unique Identifier version 4):

```typescript
@PrimaryGeneratedColumn('uuid')
id!: string;
```

**UUID v4 Characteristics**:
- **Format**: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx` (36 characters with hyphens)
- **Hex Format**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (32 hexadecimal characters)
- **Entropy**: 122 bits (2^122 ≈ 5.3 × 10^36 possible values)
- **Collision Probability**: Extremely low (practically zero for our use case)

**Current Usage**:
- Database primary key (PostgreSQL UUID type)
- API endpoints: `/api/v1/namespaces/{namespaceId}/workspaces/{id}`
- Kubernetes resource names: `workspace-${workspaceId.substring(0, 8)}`
- URLs: Currently path-based, will be subdomain-based

**Example UUID**:
```
550e8400-e29b-41d4-a716-446655440000
```

---

## Problem Statement

### Issue with UUIDs for Subdomain Routing

For subdomain-based routing, UUIDs present several challenges:

1. **Length**: UUIDs are 36 characters (with hyphens) or 32 characters (hex)
   - Subdomain format: `{workspaceId}.ws.agentstudio.local`
   - With UUID: `550e8400-e29b-41d4-a716-446655440000.ws.agentstudio.local` (too long)
   - Even hex format: `550e8400e29b41d4a716446655440000.ws.agentstudio.local` (still long)

2. **DNS Label Limits**: 
   - Maximum 63 characters per DNS label
   - UUID hex (32 chars) + `.ws.agentstudio.local` (17 chars) = 49 chars total ✅ (fits)
   - But we want shorter for better UX and readability

3. **User Experience**:
   - Long URLs are harder to remember and share
   - Less professional appearance
   - More prone to typos when manually entered

4. **Hyphens in UUIDs**:
   - UUIDs contain hyphens which are valid in DNS but make URLs less clean
   - Example: `550e8400-e29b-41d4-a716-446655440000.ws.agentstudio.local`

5. **Overkill Entropy**:
   - UUIDs provide 122 bits of entropy (5.3 × 10^36 combinations)
   - For workspace IDs, we need much less entropy
   - We can achieve sufficient uniqueness with fewer characters

### Current Workarounds

The codebase already uses workarounds for UUID length:
```typescript
// In WorkspaceOrchestratorService.ts
const podName = `workspace-${workspaceId.substring(0, 8)}`;
const pvcName = `workspace-pvc-${workspaceId.substring(0, 8)}`;
const serviceName = `workspace-svc-${workspaceId.substring(0, 8)}`;
```

This truncation:
- Reduces entropy significantly (only 4 hex chars = 16 bits)
- Increases collision risk for Kubernetes resource names
- Doesn't solve the subdomain URL problem

---

## Requirements

### Functional Requirements

1. **Uniqueness**: Must be globally unique (or unique within namespace)
2. **Collision Resistance**: Very low probability of collisions
3. **DNS Compatibility**: Must be valid DNS subdomain label
4. **URL Safety**: Must be URL-safe (no special characters that need encoding)
5. **Readability**: Should be reasonably readable and memorable
6. **Length**: Should be as short as possible while maintaining sufficient entropy

### Technical Requirements

1. **Database Compatibility**: Must work with PostgreSQL (current database)
2. **TypeORM Compatibility**: Must work with TypeORM's ID generation
3. **Backward Compatibility**: Must support migration from existing UUIDs
4. **Performance**: ID generation should be fast (not a bottleneck)
5. **Security**: Should not be easily guessable (for security)

### Subdomain-Specific Requirements

1. **DNS Label Format**: RFC 1123 compliant
   - Alphanumeric characters (a-z, A-Z, 0-9)
   - Hyphens (-) allowed but not at start/end
   - Maximum 63 characters per label
   - Case-insensitive (DNS converts to lowercase)

2. **Recommended Length**: 
   - **8-12 characters** ideal for subdomains
   - Leaves room for `.ws.agentstudio.local` suffix
   - Example: `abc12345.ws.agentstudio.local` (8 chars) = 25 chars total

3. **Character Set**:
   - Base62 (0-9, a-z, A-Z): 62 characters
   - Or Base36 (0-9, a-z): 36 characters (lowercase only, simpler)
   - Hyphens optional but not recommended (adds complexity)

---

## Proposed Solution

### Option 1: Base62 Encoded Short ID (Recommended)

**Format**: 8-12 character base62 string (0-9, a-z, A-Z)

**Generation**:
```typescript
import { randomBytes } from 'crypto';

function generateShortWorkspaceId(length: number = 10): string {
  // Generate random bytes
  const bytes = randomBytes(Math.ceil(length * 3 / 4)); // 3/4 ratio for base62
  
  // Convert to base62
  const base62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  let num = 0;
  
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8) + bytes[i];
    if ((i + 1) % 3 === 0 || i === bytes.length - 1) {
      let temp = '';
      while (num > 0) {
        temp = base62[num % 62] + temp;
        num = Math.floor(num / 62);
      }
      result += temp.padStart(3, '0');
    }
  }
  
  return result.substring(0, length);
}
```

**Characteristics**:
- **Length**: 10 characters (configurable 8-12)
- **Character Set**: Base62 (0-9, a-z, A-Z)
- **Entropy**: ~59 bits for 10 chars (62^10 ≈ 8.4 × 10^17 combinations)
- **Example**: `a3K9mP2xQ7`

**Pros**:
- ✅ Short and readable
- ✅ High entropy (sufficient for workspace IDs)
- ✅ URL-safe
- ✅ DNS-compatible
- ✅ Case-sensitive (more entropy)

**Cons**:
- ⚠️ Case-sensitive (but DNS converts to lowercase, so we should use lowercase only)
- ⚠️ Slightly more complex encoding

---

### Option 2: Base36 Encoded Short ID (Simpler Alternative)

**Format**: 10-12 character base36 string (0-9, a-z, lowercase only)

**Generation**:
```typescript
import { randomBytes } from 'crypto';

function generateShortWorkspaceId(length: number = 10): string {
  const bytes = randomBytes(Math.ceil(length * 5 / 8)); // 5/8 ratio for base36
  const base36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  
  let result = '';
  let num = BigInt('0x' + bytes.toString('hex'));
  
  while (num > 0 && result.length < length) {
    result = base36[Number(num % 36n)] + result;
    num = num / 36n;
  }
  
  // Pad with random if needed
  while (result.length < length) {
    const extraByte = randomBytes(1)[0];
    result = base36[extraByte % 36] + result;
  }
  
  return result;
}
```

**Characteristics**:
- **Length**: 10 characters
- **Character Set**: Base36 (0-9, a-z, lowercase only)
- **Entropy**: ~51 bits for 10 chars (36^10 ≈ 3.7 × 10^15 combinations)
- **Example**: `a3k9mp2xq7`

**Pros**:
- ✅ Simpler encoding (base36 is easier than base62)
- ✅ Lowercase only (matches DNS behavior)
- ✅ Still high entropy
- ✅ URL-safe and DNS-compatible

**Cons**:
- ⚠️ Less entropy than base62 (but still sufficient)

---

### Option 3: NanoID (Library-Based)

**Format**: Configurable length, URL-safe characters

**Implementation**:
```typescript
import { customAlphabet } from 'nanoid';

// Base36 alphabet (0-9, a-z)
const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function generateShortWorkspaceId(): string {
  return nanoid();
}
```

**Characteristics**:
- **Length**: 10 characters (configurable)
- **Character Set**: Configurable (base36 recommended)
- **Entropy**: ~51 bits for 10 chars with base36
- **Example**: `k3j9h2p8x1`

**Pros**:
- ✅ Well-tested library
- ✅ Configurable alphabet and length
- ✅ Fast generation
- ✅ URL-safe by default

**Cons**:
- ⚠️ Additional dependency
- ⚠️ Less control over exact format

---

## Entropy Analysis

### Entropy Requirements

**Collision Probability Calculation**:
- For **n** workspaces, probability of at least one collision:
  - P(collision) ≈ n² / (2 × m)
  - Where **m** = number of possible IDs

**Target**: < 0.01% (1 in 10,000) collision probability for 1 million workspaces

### Comparison of Options

| Format | Length | Character Set | Entropy (bits) | Combinations | Collision Risk (1M workspaces) |
|--------|--------|---------------|----------------|--------------|--------------------------------|
| **UUID v4** | 32 hex | 0-9, a-f | 122 | 5.3 × 10^36 | ~0 (negligible) |
| **Base62 (10 chars)** | 10 | 0-9, a-z, A-Z | ~59 | 8.4 × 10^17 | ~0.0006% |
| **Base36 (10 chars)** | 10 | 0-9, a-z | ~51 | 3.7 × 10^15 | ~0.14% |
| **Base36 (12 chars)** | 12 | 0-9, a-z | ~62 | 4.7 × 10^18 | ~0.0001% |
| **Base62 (8 chars)** | 8 | 0-9, a-z, A-Z | ~48 | 2.2 × 10^14 | ~0.23% |

### Recommendation

**Base36 with 10 characters** is the sweet spot:
- ✅ Sufficient entropy (0.14% collision risk for 1M workspaces is acceptable)
- ✅ Simple implementation (base36 is straightforward)
- ✅ Lowercase only (matches DNS behavior)
- ✅ Short enough for clean subdomains
- ✅ If more entropy needed, can increase to 12 chars (0.0001% risk)

**For higher scale**: Use **Base36 with 12 characters**:
- ✅ Even lower collision risk
- ✅ Still short enough (12 chars + `.ws.agentstudio.local` = 29 chars total)
- ✅ Better for long-term growth

---

## Implementation Approach

### Phase 1: ID Generation Service

Create a new service for generating short workspace IDs:

**File**: `src/nemo/config-service/services/WorkspaceIdGenerator.ts`

```typescript
import { randomBytes } from 'crypto';

/**
 * Generates a short, URL-safe workspace ID
 * Format: Base36 (0-9, a-z), 10-12 characters
 * 
 * Entropy: ~51 bits for 10 chars, ~62 bits for 12 chars
 * Collision probability: < 0.2% for 1M workspaces (10 chars)
 */
export class WorkspaceIdGenerator {
  private static readonly BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  private static readonly DEFAULT_LENGTH = 10;
  private static readonly MAX_LENGTH = 12;

  /**
   * Generate a short workspace ID
   * @param length - Desired length (10-12, default 10)
   * @returns Base36 encoded workspace ID
   */
  static generate(length: number = this.DEFAULT_LENGTH): string {
    if (length < 8 || length > this.MAX_LENGTH) {
      throw new Error(`Workspace ID length must be between 8 and ${this.MAX_LENGTH}`);
    }

    // Generate enough random bytes for desired entropy
    // Base36: each char represents ~5.17 bits (log2(36))
    // For 10 chars: need ~52 bits = 7 bytes
    // For 12 chars: need ~62 bits = 8 bytes
    const bytesNeeded = Math.ceil((length * Math.log2(36)) / 8);
    const bytes = randomBytes(bytesNeeded);

    // Convert to base36
    let num = BigInt('0x' + bytes.toString('hex'));
    let result = '';

    while (num > 0 && result.length < length) {
      result = this.BASE36[Number(num % 36n)] + result;
      num = num / 36n;
    }

    // Pad with random if needed (shouldn't happen with correct bytesNeeded)
    while (result.length < length) {
      const extraByte = randomBytes(1)[0];
      result = this.BASE36[extraByte % 36] + result;
    }

    return result;
  }

  /**
   * Validate workspace ID format
   */
  static validate(workspaceId: string): boolean {
    // Must be base36 (0-9, a-z)
    if (!/^[0-9a-z]+$/.test(workspaceId)) {
      return false;
    }

    // Length check
    if (workspaceId.length < 8 || workspaceId.length > this.MAX_LENGTH) {
      return false;
    }

    // DNS label validation (no leading/trailing hyphens, no consecutive hyphens)
    // Since we use base36 only, no hyphens, so this is automatically satisfied

    return true;
  }

  /**
   * Sanitize existing ID for subdomain use
   * Converts UUID or other formats to base36-compatible format
   */
  static sanitizeForSubdomain(id: string): string {
    // Remove hyphens and convert to lowercase
    let sanitized = id.toLowerCase().replace(/-/g, '');

    // Remove non-base36 characters
    sanitized = sanitized.replace(/[^0-9a-z]/g, '');

    // Truncate to max length
    if (sanitized.length > this.MAX_LENGTH) {
      sanitized = sanitized.substring(0, this.MAX_LENGTH);
    }

    // Pad if too short (shouldn't happen with UUIDs)
    if (sanitized.length < 8) {
      // Generate additional random chars
      const needed = 8 - sanitized.length;
      sanitized = sanitized + this.generate(needed);
    }

    return sanitized;
  }
}
```

### Phase 2: Update Workspace Model

**Option A: Custom ID Generation (Recommended)**

```typescript
import { BeforeInsert, Entity, PrimaryColumn } from 'typeorm';
import { WorkspaceIdGenerator } from '../services/WorkspaceIdGenerator';

@Entity('workspaces')
export class Workspace {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = WorkspaceIdGenerator.generate(10);
    }
  }

  // ... rest of the model
}
```

**Option B: Keep UUID, Add Short ID Field**

```typescript
@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id!: string; // Keep UUID for backward compatibility

  @Column('varchar', { length: 12, unique: true, nullable: true })
  shortId?: string; // New short ID for subdomains

  @BeforeInsert()
  generateShortId() {
    if (!this.shortId) {
      this.shortId = WorkspaceIdGenerator.generate(10);
    }
  }

  // ... rest of the model
}
```

**Recommendation**: Use **Option A** (replace UUID with short ID) for cleaner implementation, but requires migration.

### Phase 3: Update TypeORM Configuration

If using custom ID generation, ensure TypeORM doesn't auto-generate:

```typescript
// In WorkspaceService.createWorkspace()
const workspace = repo.create({
  // Don't set id - it will be generated by @BeforeInsert hook
  namespaceId,
  templateId: data.templateId,
  name: data.name,
  // ... other fields
});
```

### Phase 4: Update API and Frontend

1. **API Routes**: Already use `{id}` parameter, no change needed
2. **Frontend**: Update URL generation to use short IDs
3. **Validation**: Add workspace ID format validation

---

## Migration Strategy

### Migration Approach

**Option 1: Clean Migration (Recommended for New Deployments)**
- Generate short IDs for all new workspaces
- Keep existing UUID workspaces (dual support during transition)
- Migrate existing workspaces on next access/update
- Eventually deprecate UUID support

**Option 2: Dual ID Support (Safer for Production)**
- Add `shortId` field alongside `id` (UUID)
- Generate short ID for all workspaces (new and existing)
- Use short ID for subdomains, UUID for internal references
- Gradually migrate to short ID only

**Option 3: Big Bang Migration (Risky)**
- Generate short IDs for all existing workspaces
- Update all references immediately
- Higher risk but faster

### Migration Script

```typescript
// Migration script to generate short IDs for existing workspaces
async function migrateWorkspaceIds() {
  const repo = workspaceRepo();
  const workspaces = await repo.find({ where: { shortId: null } });

  for (const workspace of workspaces) {
    // Generate short ID
    let shortId = WorkspaceIdGenerator.generate(10);
    
    // Ensure uniqueness (retry if collision)
    let attempts = 0;
    while (await repo.findOne({ where: { shortId } }) && attempts < 10) {
      shortId = WorkspaceIdGenerator.generate(10);
      attempts++;
    }

    if (attempts >= 10) {
      console.error(`Failed to generate unique short ID for workspace ${workspace.id}`);
      continue;
    }

    workspace.shortId = shortId;
    await repo.save(workspace);
    console.log(`Migrated workspace ${workspace.id} -> ${shortId}`);
  }
}
```

### Backward Compatibility

During migration, support both formats:

```typescript
// In API Gateway routing
function extractWorkspaceId(hostname: string): string {
  const match = hostname.match(/^([a-z0-9-]+)\.ws\.agentstudio\.io$/);
  if (!match) return null;

  const id = match[1];
  
  // Check if it's a short ID (8-12 base36 chars) or UUID (32 hex chars)
  if (/^[0-9a-z]{8,12}$/.test(id)) {
    return id; // Short ID
  } else if (/^[0-9a-f]{32}$/.test(id.replace(/-/g, ''))) {
    // UUID format - lookup short ID
    return lookupShortIdFromUuid(id);
  }
  
  return null;
}
```

---

## Testing Considerations

### Unit Tests

```typescript
describe('WorkspaceIdGenerator', () => {
  it('should generate 10-character base36 IDs', () => {
    const id = WorkspaceIdGenerator.generate(10);
    expect(id).toMatch(/^[0-9a-z]{10}$/);
    expect(id.length).toBe(10);
  });

  it('should generate unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      ids.add(WorkspaceIdGenerator.generate());
    }
    expect(ids.size).toBe(1000); // No collisions in 1000 generations
  });

  it('should validate correct IDs', () => {
    expect(WorkspaceIdGenerator.validate('abc123xyz9')).toBe(true);
    expect(WorkspaceIdGenerator.validate('ABC123')).toBe(false); // Uppercase
    expect(WorkspaceIdGenerator.validate('abc-123')).toBe(false); // Hyphens
    expect(WorkspaceIdGenerator.validate('abc')).toBe(false); // Too short
  });

  it('should sanitize UUIDs correctly', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const sanitized = WorkspaceIdGenerator.sanitizeForSubdomain(uuid);
    expect(sanitized).toMatch(/^[0-9a-z]{8,12}$/);
  });
});
```

### Integration Tests

- Test workspace creation with short IDs
- Test subdomain routing with short IDs
- Test collision handling
- Test migration script

### Performance Tests

- ID generation speed (should be < 1ms)
- Database query performance with new ID format
- Subdomain resolution performance

---

## Recommendations

### Recommended Format

**Base36, 10 characters, lowercase only**

**Rationale**:
1. ✅ Sufficient entropy (0.14% collision risk for 1M workspaces)
2. ✅ Simple implementation (base36 is straightforward)
3. ✅ DNS-compatible (lowercase matches DNS behavior)
4. ✅ Short enough for clean URLs
5. ✅ Easy to read and type

**Example IDs**:
- `a3k9mp2xq7`
- `k2j8h4p9x1`
- `m5n3q7r2s9`

**Subdomain Examples**:
- `a3k9mp2xq7.ws.agentstudio.local` (25 characters total)
- `k2j8h4p9x1.ws.agentstudio.local` (25 characters total)

### Implementation Priority

1. **Phase 1**: Create `WorkspaceIdGenerator` service
2. **Phase 2**: Update workspace model to use short IDs (with migration support)
3. **Phase 3**: Migrate existing workspaces
4. **Phase 4**: Update subdomain routing to use short IDs
5. **Phase 5**: Remove UUID support (after full migration)

### Future Considerations

- **Scale**: If workspace count exceeds 10M, consider increasing to 12 characters
- **Collision Detection**: Implement collision detection and retry logic
- **ID Format Versioning**: Consider versioning ID format for future changes

---

## Appendix

### Entropy Calculation Details

**Base36 Entropy**:
- 36 possible characters per position
- For **n** characters: Entropy = n × log₂(36) ≈ n × 5.17 bits
- 10 chars: ~51.7 bits
- 12 chars: ~62.0 bits

**Collision Probability**:
- For **n** workspaces and **m** possible IDs:
  - P(collision) ≈ n² / (2 × m)
- With 10 chars (3.7 × 10^15 combinations):
  - 1M workspaces: P ≈ 0.14%
  - 10M workspaces: P ≈ 13.5% (too high, need 12 chars)
- With 12 chars (4.7 × 10^18 combinations):
  - 1M workspaces: P ≈ 0.0001%
  - 10M workspaces: P ≈ 0.01%
  - 100M workspaces: P ≈ 1.06%

### Character Set Comparison

| Format | Characters | Bits per Char | 10 Chars Entropy | 12 Chars Entropy |
|--------|-----------|---------------|------------------|------------------|
| Base36 | 36 | 5.17 | 51.7 bits | 62.0 bits |
| Base62 | 62 | 5.95 | 59.5 bits | 71.4 bits |
| Hex | 16 | 4.00 | 40.0 bits | 48.0 bits |
| Decimal | 10 | 3.32 | 33.2 bits | 39.8 bits |

---

**Next Steps**: Review design, implement `WorkspaceIdGenerator`, update workspace model, plan migration.

