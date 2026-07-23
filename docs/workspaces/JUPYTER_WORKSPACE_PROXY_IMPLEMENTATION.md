# Jupyter Workspace Proxy - Implementation Guide

## Quick Summary

This guide provides step-by-step implementation instructions for proxying JupyterLab workspaces through the API Gateway with automated token generation and management.

**Key Change**: Instead of extracting tokens from logs, we generate tokens before pod creation and pass them via the `JUPYTER_TOKEN` environment variable, which JupyterLab Docker images support natively.

## Architecture Flow

```
User → API Gateway (/workspace/:id) → Config Service (get token) → JupyterLab Pod (with token)
```

## Implementation Steps

### Step 1: Token Generation Service

**File**: `src/nemo/workspace-manager/src/services/TokenGenerationService.ts`

Create a new service to generate secure Jupyter tokens:

```typescript
import { randomBytes } from 'crypto';

export class TokenGenerationService {
  /**
   * Generate a secure random token for JupyterLab
   * JupyterLab tokens are typically 48-64 character alphanumeric strings
   * This generates a 48-character token using cryptographically secure random bytes
   */
  static generateToken(): string {
    // Generate 24 random bytes (192 bits) and convert to hex
    // This gives us exactly 48 hex characters
    const bytes = randomBytes(24);
    return bytes.toString('hex');
  }

  /**
   * Alternative: Generate token using base64url format
   * Some prefer this format for readability
   */
  static generateTokenBase64(): string {
    // Generate 32 random bytes (256 bits) and convert to base64url
    const bytes = randomBytes(32);
    const base64 = bytes.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    // Pad to 48 characters for JupyterLab compatibility
    return base64.padEnd(48, '0').substring(0, 48);
  }
}
```

### Step 2: Update Workspace Model

**File**: `src/nemo/config-service/models/Workspace.ts`

The metadata field already exists. Ensure it can store the token:

```typescript
// Metadata structure (already exists, just document it):
metadata?: {
  // ... existing fields ...
  jupyterToken?: string;
  tokenGeneratedAt?: string;
}
```

### Step 3: Add Token Update Service Method

**File**: `src/nemo/config-service/services/WorkspaceService.ts`

Add method to update workspace token:

```typescript
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

### Step 4: Add Token Update Route

**File**: `src/nemo/config-service/routes/workspaceRoutes.ts`

Add internal route for token updates:

```typescript
/**
 * Internal route for updating workspace token (used by workspace-manager)
 * @swagger
 * /api/v1/namespaces/{namespaceId}/workspaces/{id}/token:
 *   put:
 *     summary: Update workspace token (internal)
 */
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

### Step 5: Integrate Token Generation in Workspace Launch

**File**: `src/nemo/workspace-manager/src/services/WorkspaceOrchestratorService.ts`

Update `launchWorkspace` method to generate token BEFORE creating pod:

```typescript
// BEFORE creating the pod, generate and store token:
// 1. Generate token
const token = TokenGenerationService.generateToken();
console.log(`[WorkspaceManager] Generated token for workspace ${workspaceId}`);

// 2. Store token in workspace metadata via config-service
try {
  const configServiceUrl = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
  const response = await fetch(
    `${configServiceUrl}/api/v1/namespaces/${namespaceId}/workspaces/${workspaceId}/token`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }
  );
  
  if (!response.ok) {
    throw new Error(`Failed to store token: ${response.statusText}`);
  }
  
  console.log(`[WorkspaceManager] Token stored for workspace ${workspaceId}`);
} catch (error: any) {
  console.error(`[WorkspaceManager] Error storing token for ${workspaceId}:`, error.message);
  throw error; // Fail workspace creation if token storage fails
}

// 3. Create pod with token passed as environment variable
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

**Note**: You'll need to:
1. Update `createWorkspacePod` method signature to accept `jupyterToken` parameter:

```typescript
private static async createWorkspacePod(
  coreApi: k8s.CoreV1Api,
  namespace: string,
  podName: string,
  pvcName: string,
  workspaceId: string,
  template: WorkspaceTemplate,
  secretName?: string,
  s3BucketName?: string,
  jupyterToken?: string // Add this parameter
): Promise<void> {
  // ... existing code ...
  
  env: [
    {
      name: 'JUPYTER_ENABLE_LAB',
      value: 'yes',
    },
    {
      name: 'JUPYTER_TOKEN',
      value: jupyterToken || '', // Use generated token instead of empty string
    },
    // ... rest of env vars ...
  ],
}
```

3. Ensure `namespaceId` is available in the `launchWorkspace` method (may need to add it to `LaunchWorkspaceRequest` or fetch from workspace)

### Step 6: Add Workspace Proxy to API Gateway

**File**: `src/nemo/apigateway-service/src/server/Server.ts`

Add workspace proxy route:

```typescript
import fetch from 'node-fetch'; // or use built-in fetch if Node 18+

protected setupRoutes(): void {
  super.setupRoutes();

  // ... existing routes ...

  // Workspace proxy route - must be before catch-all
  this.getApp().use('/workspace/:workspaceId', async (req: Request, res: Response, next: NextFunction) => {
    const { workspaceId } = req.params;
    
    try {
      // Get workspace details from config-service
      const workspace = await this.getWorkspaceDetails(workspaceId);
      
      if (!workspace || workspace.status !== 'running') {
        return res.status(404).json({ 
          error: 'Workspace not found or not running',
          workspaceId 
        });
      }

      // Get token from metadata
      const token = workspace.metadata?.jupyterToken;
      if (!token) {
        return res.status(503).json({ 
          error: 'Workspace token not available yet',
          message: 'Token generation in progress. Please try again in a few moments.',
          workspaceId
        });
      }

      // Verify workspace endpoint exists
      if (!workspace.endpoint) {
        return res.status(503).json({ 
          error: 'Workspace endpoint not configured',
          workspaceId
        });
      }

      // Create proxy middleware for this workspace
      const workspaceProxyOptions: Options = {
        target: workspace.endpoint,
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
            // Handle redirects - inject token
            if (proxyRes.statusCode === 302 || proxyRes.statusCode === 301) {
              const location = proxyRes.headers.location;
              if (location && !location.includes('token=')) {
                try {
                  const url = new URL(location, workspace.endpoint);
                  url.searchParams.set('token', token);
                  proxyRes.headers.location = url.toString();
                } catch (e) {
                  // Invalid URL, skip
                }
              }
            }
          },
        },
        ws: true, // Enable WebSocket support for JupyterLab
      } as Options;

      // Create and use proxy middleware
      const proxy = createProxyMiddleware(workspaceProxyOptions);
      proxy(req, res, next);
    } catch (error: any) {
      console.error(`[API Gateway] Error proxying workspace ${workspaceId}:`, error);
      res.status(500).json({ 
        error: 'Failed to proxy workspace', 
        message: error.message,
        workspaceId
      });
    }
  });

  // ... rest of routes ...
}

private async getWorkspaceDetails(workspaceId: string): Promise<any> {
  const configServiceUrl = this.configServiceUrl || this.getConfigServiceUrl(this.config);
  
  try {
    const response = await fetch(`${configServiceUrl}/api/v1/workspaces/${workspaceId}`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch workspace: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.data || data; // Handle different response formats
  } catch (error: any) {
    console.error(`[API Gateway] Error fetching workspace ${workspaceId}:`, error);
    throw error;
  }
}
```

**Note**: You may need to update the workspace lookup to include namespaceId. Consider:
- Adding namespaceId as a query parameter: `/workspace/:workspaceId?namespaceId=xxx`
- Or storing namespaceId in a session/cookie
- Or using a different route structure: `/workspace/:namespaceId/:workspaceId`

### Step 7: Update Middleware to Skip Body Parsing for Workspace Routes

**File**: `src/nemo/apigateway-service/src/server/Server.ts`

Update `setupMiddleware`:

```typescript
protected setupMiddleware(): void {
  // Skip body parsing for proxied routes
  this.getApp().use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    
    // Skip body parsing for proxied routes
    if (path.startsWith('/config') || path.startsWith('/console') || path.startsWith('/workspace')) {
      return next();
    }
    
    // Use JSON parser for other routes
    return express.json()(req, res, next);
  });

  // ... rest of middleware ...
}
```

### Step 8: Update Frontend (Glass Console)

**File**: `src/nemo/gui/src/pages/NamespaceWorkspaces.tsx`

Add "Open Workspace" button:

```typescript
// In the workspace list/table, add:
<Button
  variant="contained"
  color="primary"
  onClick={() => {
    const url = `/workspace/${workspace.id}/lab`;
    window.open(url, '_blank');
  }}
  disabled={workspace.status !== 'running'}
  sx={{ mr: 1 }}
>
  Open JupyterLab
</Button>
```

Or create a link:

```typescript
<Link
  to={`/workspace/${workspace.id}/lab`}
  target="_blank"
  style={{ textDecoration: 'none' }}
>
  <Button
    variant="contained"
    disabled={workspace.status !== 'running'}
  >
    Open JupyterLab
  </Button>
</Link>
```

## Testing

### Manual Testing Steps

1. **Launch a workspace**:
   ```bash
   curl -X POST http://localhost:8080/config/api/v1/namespaces/{namespaceId}/workspaces/{id}/launch
   ```

2. **Verify token is generated and stored** (check workspace-manager logs):
   ```bash
   kubectl logs -n agentstudio-services -l app=workspace-manager | grep "Generated token"
   kubectl logs -n agentstudio-services -l app=workspace-manager | grep "Token stored"
   ```

3. **Verify token is in workspace metadata**:
   ```bash
   curl http://localhost:8080/config/api/v1/namespaces/{namespaceId}/workspaces/{id}
   # Check metadata.jupyterToken exists and is not empty
   ```

4. **Verify token is set in pod**:
   ```bash
   kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[0].env[?(@.name=="JUPYTER_TOKEN")].value}'
   # Should show the generated token
   ```

5. **Access workspace via proxy**:
   ```bash
   # Open in browser:
   http://localhost:8080/workspace/{workspaceId}/lab
   ```

### Integration Test

```typescript
// Example test structure
describe('Jupyter Workspace Proxy', () => {
  it('should generate and store token before pod creation', async () => {
    // Generate token
    const token = TokenGenerationService.generateToken();
    expect(token).toBeDefined();
    expect(token.length).toBe(48);
    
    // Launch workspace
    // Verify token is stored in metadata before pod is created
    // Verify token is set in pod environment variable
  });

  it('should proxy workspace requests with token', async () => {
    // Setup workspace with token
    // Make request to /workspace/:id/lab
    // Verify token is injected
    // Verify response is from JupyterLab
  });
});
```

## Security Considerations

1. **Token Storage**: Consider encrypting tokens in database
2. **Access Control**: Add authentication/authorization middleware
3. **Token Transmission**: Prefer cookies over query params when possible
4. **Rate Limiting**: Add rate limiting for workspace endpoints

## Troubleshooting

### Token Not Generated

- Check workspace-manager logs for token generation errors
- Verify crypto module is available (should be built-in to Node.js)
- Check that token generation happens before pod creation

### Token Not Set in Pod

- Verify `JUPYTER_TOKEN` environment variable in pod spec:
  ```bash
  kubectl get pod <pod-name> -n <namespace> -o yaml | grep JUPYTER_TOKEN
  ```
- Check that token parameter is passed to `createWorkspacePod` method
- Verify token is not empty or undefined

### Proxy Not Working

- Verify workspace endpoint is correct
- Check API Gateway logs
- Verify token is present in workspace metadata
- Test direct access to workspace endpoint

### WebSocket Issues

- Ensure `ws: true` is set in proxy options
- Check if JupyterLab WebSocket path is correct
- Verify network policies allow WebSocket connections

## Next Steps

1. Add authentication middleware
2. Implement token refresh mechanism
3. Add workspace access logging
4. Implement rate limiting
5. Add monitoring and alerts

