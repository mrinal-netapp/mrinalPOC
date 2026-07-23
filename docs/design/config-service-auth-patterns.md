# Config-Service Auth Pattern: When to Use SA Token vs Forward User RPT

**Date:** 2026-07-01  
**Question:** Does config-service fetch SA token when calling workflow-engine, or forward user RPT? Where is the logic?

---

## Answer: IT DEPENDS ON THE USE CASE

Config-service uses **BOTH patterns** depending on who initiated the call:

1. **User-initiated flows** → Forward user RPT
2. **System-initiated flows** → Use SA token

---

## Pattern 1: User RPT Forwarding (ProjectInitService)

### When Used:
- User creates a project via GUI/API
- User triggers ProjectInit workflow
- **Must preserve user identity for Keycloak policy creation**

### Implementation:

**File:** `src/nemo/config-service/services/ProjectInitService.ts`

```typescript
/**
 * The HTTP call to workflow-engine **must carry the originating user's
 * Authorization header**, not a service-account token. workflow-engine derives
 * the project owner from `claims.sub` on this request and writes a Keycloak
 * user-policy `usr-{ownerSub}-proj-{projectId}-admin`. If we authenticated as
 * the config-service service account, the SA's user UUID would land in that
 * policy, leaving the real human creator with no admin grant.
 */
export class ProjectInitService extends BaseService {
  async initializeProject(projectId: string, userAuthHeader: string): Promise<void> {
    if (!userAuthHeader) {
      throw new Error('initializeProject requires the caller\'s Authorization header');
    }

    const client: AxiosInstance = axios.create({
      headers: {
        Authorization: userAuthHeader,  // ← FORWARDS USER RPT
      },
    });

    await client.post(`/api/v1/projects/${projectId}/init`, requestBody);
  }
}
```

### Caller (projectRoutes.ts):

```typescript
// POST /api/v1/projects
router.post('/projects', async (req, res) => {
  // Project init must run as the originating human user so that the
  // resulting Keycloak admin policy is bound to the creator's sub, not the
  // config-service service account. authMiddleware already validated this
  // header; we forward it verbatim to workflow-engine.
  const userAuthHeader = req.headers.authorization;  // ← EXTRACTS USER HEADER
  if (!userAuthHeader || !req.user?.sub) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }

  const project = await projectRepo.create(requestBody, projectId, homeDir);
  
  const initService = new ProjectInitService();
  initService.initializeProject(projectId, userAuthHeader);  // ← PASSES USER HEADER
});
```

### Why This Pattern:
- **Keycloak policy must be tied to human user, not service account**
- Workflow-engine extracts `req.user.sub` from JWT
- Creates policy: `usr-<human-uuid>-proj-{projectId}-admin`
- User becomes project admin, not config-service SA

### Flow:
```
Browser (user RPT) → config-service → workflow-engine
                      ↓ forwards      ↓ decodes
                    user RPT        user sub → Keycloak policy
```

---

## Pattern 2: Service Account Token (DatasetImportService)

### When Used:
- Dataset processor worker completes import
- System-initiated background jobs
- No user context needed (pure system operation)

### Implementation:

**File:** `src/nemo/config-service/services/DatasetImportService.ts`

```typescript
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';

export class DatasetImportService extends BaseService {
  private client: AxiosInstance;
  private serviceAccountClient: ServiceAccountClient | null = null;

  constructor() {
    // Initialize service account client for service-to-service authentication
    this.serviceAccountClient = createServiceAccountClientFromEnv();
    
    if (this.serviceAccountClient) {
      // Use authenticated client that automatically adds Authorization header
      this.client = this.serviceAccountClient.createAuthenticatedClient(this.executorServiceUrl);
      // ↑ USES SA TOKEN - interceptor auto-injects Bearer token
    } else {
      // Fallback to unauthenticated client
      this.client = axios.create({ baseURL: this.executorServiceUrl });
    }
  }

  async startDatasetImport(projectId: string, datasetId: string, ...): Promise<string | null> {
    // This client automatically includes: Authorization: Bearer <SA-token>
    const response = await this.client.post(
      `/api/v1/projects/${projectId}/datasets/${datasetId}/import`,
      requestBody
    );
    return response.data?.workflowId;
  }
}
```

### ServiceAccountClient Implementation:

**File:** `src/common/src/auth/ServiceAccountClient.ts`

```typescript
export class ServiceAccountClient {
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  /**
   * Get access token (with caching and automatic refresh)
   */
  async getAccessToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;  // ← CACHED
    }

    // Fetch new token using client credentials flow
    const tokenUrl = `${this.issuer}/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',  // ← OAUTH2 CLIENT CREDENTIALS
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'openid profile email',
    });

    const response = await this.httpClient.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    this.accessToken = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000) - 60000; // Refresh 1 min before expiry

    return this.accessToken;
  }

  /**
   * Create an authenticated HTTP client with automatic token injection
   */
  createAuthenticatedClient(baseURL: string): AxiosInstance {
    const client = axios.create({ baseURL, timeout: 30000 });

    // Add request interceptor to include token
    client.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();  // ← FETCHES/CACHES SA TOKEN
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;  // ← AUTO-INJECTS
      }
      return config;
    });

    return client;
  }
}

/**
 * Create from environment variables
 */
export function createServiceAccountClientFromEnv(): ServiceAccountClient | null {
  const issuer = process.env.KEYCLOAK_ISSUER;
  const clientId = process.env.KEYCLOAK_SERVICE_ACCOUNT_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_SERVICE_ACCOUNT_CLIENT_SECRET;

  if (!issuer || !clientId || !clientSecret) {
    return null;  // ← Falls back to tokenless mTLS
  }

  return new ServiceAccountClient(issuer, clientId, clientSecret);
}
```

### Why This Pattern:
- **No user context exists** (system operation)
- **Token caching** (1 min before expiry refresh)
- **Automatic injection** (interceptor handles it)
- **Falls back to tokenless** if SA not configured

### Flow:
```
System job → config-service → workflow-engine
              ↓ creates SA token   ↓ validates SA token
           (cached, auto-inject)  (workflow-engine guard)
```

---

## Decision Matrix: Which Pattern When?

| Scenario | Pattern | Why |
|----------|---------|-----|
| **User creates project** | User RPT forwarding | Keycloak policy must be tied to user |
| **User triggers dataset import via GUI** | User RPT forwarding | User attribution in audit logs |
| **Worker callback (import complete)** | SA token | No user in context, pure system op |
| **Scheduled cron job** | SA token | System-initiated, no user |
| **User deletes project** | User RPT forwarding | User attribution for destructive op |
| **Background job status update** | SA token | System callback, no user needed |

---

## The Logic: Where Decision Happens

### Explicit Decision (ProjectInitService):
```typescript
// EXPLICIT: Service explicitly requires user header as parameter
async initializeProject(projectId: string, userAuthHeader: string) {
  if (!userAuthHeader) {
    throw new Error('requires user Authorization header');
  }
  // Creates axios client with user header
  const client = axios.create({ headers: { Authorization: userAuthHeader } });
}
```

**Decision point:** Service signature requires `userAuthHeader` parameter

---

### Implicit Decision (DatasetImportService):
```typescript
constructor() {
  // IMPLICIT: Service constructor decides to use SA client
  this.serviceAccountClient = createServiceAccountClientFromEnv();
  this.client = this.serviceAccountClient.createAuthenticatedClient(url);
}

// No userAuthHeader parameter - uses SA token automatically
async startDatasetImport(projectId: string, datasetId: string, ...) {
  await this.client.post(...);  // ← SA token injected by interceptor
}
```

**Decision point:** Constructor instantiation choice

---

## Comparison: Side-by-Side

### ProjectInitService (User RPT)
```typescript
✅ Extends BaseService (no auth logic)
✅ Creates plain axios.create() per-call
✅ Manually sets Authorization: userAuthHeader
✅ Requires caller to pass user header
✅ No token fetching/caching
✅ Forwards user identity end-to-end
```

### DatasetImportService (SA Token)
```typescript
✅ Extends BaseService (no auth logic)
✅ Uses ServiceAccountClient in constructor
✅ createAuthenticatedClient() with interceptor
✅ Automatic token fetch + cache + inject
✅ No user context needed
✅ System attribution in audit logs
```

---

## Token Lifecycle: Service Account Token

```
1. Config-service starts
   ↓
2. DatasetImportService constructor
   ↓
3. createServiceAccountClientFromEnv()
   - Reads KEYCLOAK_ISSUER
   - Reads KEYCLOAK_SERVICE_ACCOUNT_CLIENT_ID
   - Reads KEYCLOAK_SERVICE_ACCOUNT_CLIENT_SECRET
   ↓
4. First request to workflow-engine
   ↓
5. Interceptor: await getAccessToken()
   ↓
6. POST {issuer}/protocol/openid-connect/token
   - grant_type: client_credentials
   - client_id: agent-studio-svc-config
   - client_secret: <from K8s secret>
   ↓
7. Keycloak responds:
   {
     access_token: "eyJ...",
     expires_in: 3600
   }
   ↓
8. Cache token (expires at: now + 3600s - 60s = 59 min)
   ↓
9. Inject: Authorization: Bearer eyJ...
   ↓
10. Subsequent requests use cached token
    ↓
11. 59 minutes later: token expired, repeat from step 6
```

---

## Environment Variables

### For Service Account Pattern:
```bash
KEYCLOAK_ISSUER=http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo
KEYCLOAK_SERVICE_ACCOUNT_CLIENT_ID=agent-studio-svc-config
KEYCLOAK_SERVICE_ACCOUNT_CLIENT_SECRET=<from-kubernetes-secret>
```

**If any are missing:** `createServiceAccountClientFromEnv()` returns `null`, falls back to tokenless mTLS.

---

## Key Takeaways

1. **ProjectInitService does NOT fetch SA token** - it forwards user RPT
2. **DatasetImportService DOES fetch SA token** - via ServiceAccountClient
3. **Decision is made at service class level** - constructor choice
4. **SA token is cached** - only re-fetched when expired
5. **Interceptor auto-injects** - no manual header setting for SA pattern
6. **User RPT is manually forwarded** - explicit parameter passing
7. **Both patterns coexist** - different use cases, same codebase

---

## So My Phase 2b Documentation Was...

**✅ CORRECT** for ProjectInitService flow:
- config-service forwards user RPT (not SA token)
- workflow-engine decodes RPT → USER LANE
- Keycloak policy created with user's sub

**⚠️ INCOMPLETE** for full picture:
- Didn't mention that OTHER flows use SA tokens
- Didn't explain decision logic (explicit vs implicit)

---

## Should I Update Phase 2b?

**Recommendation:** Add a clarifying note:

```markdown
**Note:** This flow (ProjectInit) uses **user RPT forwarding** to preserve user 
identity for Keycloak policy creation. Other service-to-service flows 
(e.g., DatasetImportService) use **service account tokens** via 
ServiceAccountClient when no user context is needed.

The decision is made at service class level:
- ProjectInitService: Requires `userAuthHeader` parameter → forwards user RPT
- DatasetImportService: Uses ServiceAccountClient in constructor → SA token
```

Would you like me to add this clarification to the Phase 2b documentation in PR #152?

---

**Reviewed by:** GitHub Copilot CLI  
**Date:** 2026-07-01T14:43:00+05:30
