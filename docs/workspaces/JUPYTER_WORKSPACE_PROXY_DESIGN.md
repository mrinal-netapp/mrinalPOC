# Jupyter Workspace Proxy Design

## Overview

This document outlines the design for proxying JupyterLab workspace GUI to users through the API Gateway, with automated token generation and seamless login functionality.

### End-to-End Flow

```
1. User requests workspace launch
2. Workspace Manager generates secure token
3. Token stored in workspace metadata (Config Service)
4. Pod created with JUPYTER_TOKEN=<token> environment variable
5. JupyterLab starts with pre-configured token
6. User accesses /workspace/:id/lab via API Gateway
7. API Gateway retrieves token from workspace metadata
8. API Gateway proxies to JupyterLab with token injected
9. User accesses JupyterLab seamlessly
```

### Design Rationale

The chosen approach generates tokens **before pod creation** and passes them via the `JUPYTER_TOKEN` environment variable, rather than extracting tokens from pod logs after startup. This provides:

- **Immediate availability**: Token ready as soon as the pod starts
- **No log parsing**: Eliminates fragile regex-based log extraction
- **Reliability**: No dependency on log output format
- **Simplicity**: Uses a standard, well-documented JupyterLab feature

## Problem Statement

1. JupyterLab requires an access token for authentication
2. Users need to access JupyterLab through the API Gateway (console)
3. Manual token management is not scalable
4. Users need an automated way to login and use JupyterLab

## Solution Approach

**Preferred Method**: Generate token at workspace creation and pass via `JUPYTER_TOKEN` environment variable
- JupyterLab Docker images support `JUPYTER_TOKEN` environment variable
- Token is available immediately when pod starts
- No log parsing required
- More reliable and simpler implementation

## Architecture Components

### 1. Token Generation Service

**Location**: `src/nemo/workspace-manager/src/services/TokenGenerationService.ts`

**Responsibilities**:
- Generate secure, random tokens for JupyterLab
- Store token securely in workspace metadata before pod creation
- Pass token to JupyterLab via `JUPYTER_TOKEN` environment variable

**Token Generation**:
- Use cryptographically secure random token generator
- Token format: alphanumeric string, 48-64 characters (JupyterLab compatible)
- Store in workspace metadata immediately after generation

**Implementation Approach**:
```typescript
// Pseudo-code structure
class TokenGenerationService {
  static generateToken(): string // Generate secure random token
  static async storeToken(workspaceId: string, token: string): Promise<void>
}
```

### 2. Workspace Metadata Extension

**Location**: `src/nemo/config-service/models/Workspace.ts`

**Changes Required**:
- Add `jupyterToken` field to metadata (encrypted/stored securely)
- Add `tokenGeneratedAt` timestamp
- Add `tokenExpiry` (optional, for future token rotation)

**Updated Metadata Structure**:
```typescript
metadata?: {
  lastSyncAt?: string;
  imageTag?: string;
  libraryInstallStatus?: 'pending' | 'installing' | 'completed' | 'failed';
  errorMessage?: string;
  jupyterToken?: string;  // NEW: Generated Jupyter token
  tokenGeneratedAt?: string;  // NEW: When token was generated
  tokenExpiry?: string;  // NEW: Optional token expiry
}
```

### 3. API Gateway Proxy Route

**Location**: `src/nemo/apigateway-service/src/server/Server.ts`

**New Route**: `/workspace/:workspaceId/*`

**Responsibilities**:
- Authenticate user and verify workspace access
- Retrieve workspace details and Jupyter token
- Proxy requests to JupyterLab service with token injection
- Handle WebSocket connections for JupyterLab
- Inject token in URLs and cookies for seamless access

**Proxy Configuration**:
- Target: Workspace service URL (from workspace.endpoint)
- Path rewrite: Remove `/workspace/:workspaceId` prefix
- Token injection: Add token to query params or Authorization header
- WebSocket support: Enable for JupyterLab real-time features

### 4. Token Generation Integration

**Location**: `src/nemo/workspace-manager/src/services/WorkspaceOrchestratorService.ts`

**Changes Required**:
- Generate token before creating pod
- Store token in workspace metadata via config-service API
- Pass token to pod via `JUPYTER_TOKEN` environment variable

**Flow**:
1. Generate secure token
2. Store token in workspace metadata (via config-service)
3. Launch workspace (create pod with `JUPYTER_TOKEN` env var, create service)
4. Wait for pod to be ready
5. Token is already available - generated before pod creation
6. Mark workspace as fully ready

### 5. Config Service API Extension

**Location**: `src/nemo/config-service/services/WorkspaceService.ts`

**New Methods**:
- `updateWorkspaceToken(workspaceId: string, token: string): Promise<Workspace>`
- `getWorkspaceAccessUrl(workspaceId: string, namespaceId: string): Promise<string>`

**New Route**: 
- `PUT /api/v1/namespaces/:namespaceId/workspaces/:id/token` (internal use)

## Implementation Details

### Phase 1: Token Generation

#### Step 1.1: Create Token Generation Service

```typescript
// src/nemo/workspace-manager/src/services/TokenGenerationService.ts
import { randomBytes } from 'crypto';

export class TokenGenerationService {
  /**
   * Generate a secure random token for JupyterLab
   * JupyterLab tokens are typically 48-64 character alphanumeric strings
   */
  static generateToken(): string {
    // Generate 32 random bytes (256 bits) and convert to base64url
    // This gives us ~43 characters, which we'll pad to 48 for consistency
    const bytes = randomBytes(32);
    const base64 = bytes.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    // Pad to 48 characters for JupyterLab compatibility
    return base64.padEnd(48, '0').substring(0, 48);
  }

  /**
   * Alternative: Generate token using UUID-like format
   * Some prefer this format for readability
   */
  static generateTokenUUID(): string {
    const bytes = randomBytes(24); // 24 bytes = 48 hex characters
    return bytes.toString('hex');
  }
}
```

#### Step 1.2: Integrate Token Generation in Workspace Launch

```typescript
// In WorkspaceOrchestratorService.launchWorkspace()
// BEFORE creating the pod:

// Generate token first
const token = TokenGenerationService.generateToken();

// Store token in workspace metadata via config-service
try {
  const configServiceUrl = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
  await fetch(
    `${configServiceUrl}/api/v1/namespaces/${namespaceId}/workspaces/${workspaceId}/token`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }
  );
} catch (error) {
  console.error(`[WorkspaceManager] Failed to store token for ${workspaceId}:`, error);
  throw error; // Fail workspace creation if token storage fails
}

// Then create pod with JUPYTER_TOKEN environment variable
await this.createWorkspacePod(
  coreApi,
  namespace,
  podName,
  pvcName,
  workspaceId,
  template,
  secretName,
  s3BucketName,
  token // Pass token to pod creation
);
```

### Phase 2: Config Service Token Storage

#### Step 2.1: Add Token Update Method

```typescript
// In WorkspaceService.ts
static async updateWorkspaceToken(
  workspaceId: string,
  namespaceId: string,
  token: string
): Promise<Workspace> {
  const repo = workspaceRepo();
  const workspace = await repo.findOne({
    where: { id: workspaceId, namespaceId },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace', workspaceId);
  }

  workspace.metadata = {
    ...workspace.metadata,
    jupyterToken: token,
    tokenGeneratedAt: new Date().toISOString(),
  };

  return await repo.save(workspace);
}
```

#### Step 2.2: Add Token Update Route

```typescript
// In workspaceRoutes.ts
router.put('/:id/token', asyncHandler(async (req, res) => {
  const namespaceId = (req as WorkspaceRequest).params.namespaceId;
  const { id } = req.params;
  const { token } = req.body;
  
  if (!namespaceId || !id || !token) {
    return sendError(res, new Error('namespaceId, id, and token are required'), 400);
  }
  
  const workspace = await WorkspaceService.updateWorkspaceToken(id, namespaceId, token);
  sendSuccess(res, workspace);
}));
```

### Phase 3: API Gateway Proxy

#### Step 3.1: Add Workspace Proxy Route

```typescript
// In apigateway/src/server/Server.ts

protected setupRoutes(): void {
  // ... existing routes ...

  // Workspace proxy route
  this.getApp().use('/workspace/:workspaceId', async (req: Request, res: Response, next: NextFunction) => {
    const { workspaceId } = req.params;
    
    try {
      // Get workspace details from config-service
      const workspace = await this.getWorkspaceDetails(workspaceId);
      
      if (!workspace || workspace.status !== 'running') {
        return res.status(404).json({ error: 'Workspace not found or not running' });
      }

      // Get token from metadata
      const token = workspace.metadata?.jupyterToken;
      if (!token) {
        return res.status(503).json({ 
          error: 'Workspace token not available yet',
          message: 'Token generation in progress. Please try again in a few moments.'
        });
      }

      // Create proxy middleware for this workspace
      const workspaceProxyOptions: Options = {
        target: workspace.endpoint!,
        changeOrigin: true,
        pathRewrite: {
          [`^/workspace/${workspaceId}`]: '', // Remove workspace prefix
        },
        on: {
          proxyReq: (proxyReq: ClientRequest, req: IncomingMessage) => {
            const expressReq = req as Request;
            const url = new URL(expressReq.url || '/', 'http://localhost');
            
            // Inject token if not present
            if (!url.searchParams.has('token')) {
              url.searchParams.set('token', token);
              proxyReq.path = url.pathname + url.search;
            }
            
            // Set headers for JupyterLab
            proxyReq.setHeader('X-Forwarded-Host', expressReq.headers.host || '');
            proxyReq.setHeader('X-Forwarded-Proto', expressReq.protocol || 'http');
          },
          proxyRes: (proxyRes: IncomingMessage, req: IncomingMessage) => {
            const expressReq = req as Request;
            
            // Handle redirects - inject token
            if (proxyRes.statusCode === 302 || proxyRes.statusCode === 301) {
              const location = proxyRes.headers.location;
              if (location && !location.includes('token=')) {
                const url = new URL(location, workspace.endpoint!);
                url.searchParams.set('token', token);
                proxyRes.headers.location = url.toString();
              }
            }
          },
        },
        ws: true, // Enable WebSocket support
      } as Options;

      // Create and use proxy middleware
      const proxy = createProxyMiddleware(workspaceProxyOptions);
      proxy(req, res, next);
    } catch (error: any) {
      console.error(`[API Gateway] Error proxying workspace ${workspaceId}:`, error);
      res.status(500).json({ error: 'Failed to proxy workspace', message: error.message });
    }
  });
}

private async getWorkspaceDetails(workspaceId: string): Promise<any> {
  const configServiceUrl = this.configServiceUrl || this.getConfigServiceUrl(this.config);
  const response = await fetch(`${configServiceUrl}/api/v1/workspaces/${workspaceId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch workspace: ${response.statusText}`);
  }
  
  return await response.json();
}
```

#### Step 3.2: Add Authentication Middleware

```typescript
// Add authentication check before workspace proxy
this.getApp().use('/workspace/:workspaceId', async (req: Request, res: Response, next: NextFunction) => {
  // Extract user from session/auth token
  const userId = req.headers['x-user-id'] || req.session?.userId;
  
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Verify user has access to workspace
  const { workspaceId } = req.params;
  const hasAccess = await this.verifyWorkspaceAccess(workspaceId, userId);
  
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden', message: 'Access denied to workspace' });
  }

  next();
});
```

### Phase 4: Frontend Integration

#### Step 4.1: Update Glass Console

**Location**: `src/nemo/gui/src/pages/NamespaceWorkspaces.tsx`

**Changes**:
- Add "Open Workspace" button for running workspaces
- Link to `/workspace/:workspaceId/lab` (or root)
- Show loading state if token not available
- Poll for token availability if needed

```typescript
// Example button component
<Button
  onClick={() => {
    const url = `/workspace/${workspace.id}/lab`;
    window.open(url, '_blank');
  }}
  disabled={workspace.status !== 'running'}
>
  Open JupyterLab
</Button>
```

## Security Considerations

### 1. Token Storage
- **Encryption**: Store tokens encrypted in database
- **Access Control**: Only workspace owner/authorized users can access
- **Token Rotation**: Consider implementing token refresh mechanism

### 2. API Gateway Security
- **Authentication**: Verify user identity before proxying
- **Authorization**: Check workspace access permissions
- **Rate Limiting**: Prevent abuse of workspace endpoints
- **HTTPS**: Ensure all communications are encrypted

### 3. Token Transmission
- **Query Parameters**: Tokens in URLs are logged - use cookies when possible
- **Headers**: Prefer Authorization headers over query params
- **Expiry**: Implement token expiry and refresh mechanism

### 4. Workspace Isolation
- **Network Policies**: Ensure workspaces are isolated
- **Resource Limits**: Enforce CPU/memory limits
- **Access Logging**: Log all workspace access attempts

## Alternative Approaches

### Option 1: Environment Variable (RECOMMENDED - Current Design)
Generate token before pod creation and pass via `JUPYTER_TOKEN` environment variable:

```yaml
env:
  - name: JUPYTER_TOKEN
    value: "<pre-generated-token>"
```

**Pros**: 
- No log parsing needed
- Token available immediately when pod starts
- Works with standard JupyterLab images
- Simple and reliable
- No modifications to JupyterLab required

**Cons**: None significant

### Option 2: Log-based Token Extraction
Extract token from pod logs after startup (original approach):

**Pros**: Works if token generation fails
**Cons**: 
- Requires log parsing
- Delayed token availability
- More complex implementation
- Potential reliability issues

### Option 3: JupyterLab API
Use JupyterLab's REST API to generate tokens programmatically:

```typescript
// POST to JupyterLab API to create token
const response = await fetch(`${jupyterUrl}/api/tokens`, {
  method: 'POST',
  headers: { 'Authorization': `token ${adminToken}` }
});
```

**Pros**: Clean API-based approach
**Cons**: Requires admin token setup, more complex

### Option 4: Shared Secret
Use a shared secret between API Gateway and JupyterLab, generate session tokens:

**Pros**: More secure, no token storage needed
**Cons**: Requires JupyterLab customization

## Recommended Approach

**Primary**: Environment Variable Token (Option 1) - **CURRENT DESIGN**
- Generate secure token before pod creation
- Pass via `JUPYTER_TOKEN` environment variable
- Store in workspace metadata immediately
- Works with standard JupyterLab images
- No log parsing required
- Token available immediately

**Fallback**: Log-based extraction (Option 2)
- Use only if environment variable approach fails
- Can be implemented as backup mechanism

## Implementation Timeline

1. **Week 1**: Token generation service + integration
2. **Week 2**: Config service token storage + API
3. **Week 3**: API Gateway proxy implementation
4. **Week 4**: Frontend integration + testing
5. **Week 5**: Security hardening + documentation

## Testing Strategy

1. **Unit Tests**: Token generation and validation
2. **Integration Tests**: End-to-end workspace launch → token generation → proxy
3. **Load Tests**: Multiple concurrent workspace access
4. **Security Tests**: Access control, token leakage prevention

### Verification Checklist

- [ ] Token generation produces valid 48-character tokens
- [ ] Token is stored in workspace metadata
- [ ] Token is set in pod environment variable
- [ ] JupyterLab accepts token from environment variable
- [ ] API Gateway retrieves token from metadata
- [ ] API Gateway proxies requests with token
- [ ] User can access JupyterLab through proxy
- [ ] WebSocket connections work through proxy

## Monitoring & Observability

1. **Metrics**:
   - Token generation success rate
   - Token generation latency
   - Workspace proxy request count
   - Proxy error rate

2. **Logging**:
   - Token generation events (without logging actual tokens)
   - Workspace access events
   - Proxy errors

3. **Alerts**:
   - High token generation failure rate
   - Workspace proxy errors
   - Unauthorized access attempts

## Migration Notes

For existing workspaces using log-based token extraction:

1. Existing workspaces continue to work without changes
2. New workspaces use the environment variable approach
3. Existing workspaces pick up the new approach on next restart
4. Log extraction can be kept as a fallback mechanism during the transition

## Future Enhancements

1. **Token Refresh**: Automatic token rotation
2. **Multi-user Support**: Support for JupyterHub-style multi-user
3. **Workspace Sharing**: Allow workspace sharing with access control
4. **Custom Domains**: Per-workspace custom domains
5. **SSO Integration**: Single sign-on for workspace access

