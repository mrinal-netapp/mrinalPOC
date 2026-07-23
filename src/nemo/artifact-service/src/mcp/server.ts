import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HandlerDeps, TOOL_HANDLERS, TOOL_NAMES, ToolName } from './handlers';
import {
  ListStoresSchema,
  WhoamiSchema,
  ReadSchema,
  ListSchema,
  LogSchema,
  WriteSchema,
  DeleteSchema,
  TagSchema,
  RevertSchema,
  MergeSchema,
} from './schemas';
import { RequestContext } from '../types/Principal';

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  list_stores:
    'Discovery: list artifact stores visible to the caller in the current project.',
  whoami:
    'Return the resolved principal (user/agent/team), project, session, and effective grants.',
  read:
    "Read a file at ref:path. Returns base64-encoded bytes. Default cap 32 KB; pass max_bytes (up to 1 MB) for more. Use ref='SESSION' to read from the session branch (auto-resolved from X-Session-ID).",
  list:
    'List directory entries (metadata only — does not return bytes). Cheap.',
  log:
    'Return the commit log of a ref with structured audit trailers (X-Principal, X-Session-Id, X-Op, X-Idempotency-Key).',
  write:
    "Write a file and commit it. Creates the session branch on first write (off the default branch). Pass idempotency_key for retry-safe writes. Use ref='SESSION' to write to the agent's session branch.",
  delete:
    'Delete a file via a forward commit. Idempotent on retry via idempotency_key.',
  tag:
    'Create an annotated tag (= snapshot) at the current tip of ref. Tag carries an audit trailer.',
  revert:
    "Apply the inverse of a commit as a new forward commit (three-way revert against HEAD; changes target made are undone, anything written after target is preserved). Preserves history. Returns {status:'ok'|'noop'|'conflict', commit_oid?, conflicts?}; conflict means a path target touched was re-modified after target — caller resolves manually and writes the merged version.",
  merge:
    "Merge from_ref into into (default: store's default branch) with strategy=ff-only. Non-ff returns a structured conflict.",
};

/**
 * Build a fresh McpServer pre-bound to a single HTTP request's context.
 * We instantiate per request so each tool handler has a captured `ctx`
 * without needing AsyncLocalStorage.
 */
function buildMcpServer(deps: HandlerDeps, ctx: RequestContext): McpServer {
  const server = new McpServer({
    name: 'artifact-store',
    version: '0.1.0',
  });

  const wrap =
    (name: ToolName) =>
    async (args: unknown) => {
      const handler = TOOL_HANDLERS[name];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (handler as any)(deps, ctx, args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result) },
        ],
        isError: !result.ok,
      };
    };

  server.registerTool(
    'list_stores',
    { description: TOOL_DESCRIPTIONS.list_stores, inputSchema: ListStoresSchema.shape },
    wrap('list_stores'),
  );
  server.registerTool(
    'whoami',
    { description: TOOL_DESCRIPTIONS.whoami, inputSchema: WhoamiSchema.shape },
    wrap('whoami'),
  );
  server.registerTool(
    'read',
    { description: TOOL_DESCRIPTIONS.read, inputSchema: ReadSchema.shape },
    wrap('read'),
  );
  server.registerTool(
    'list',
    { description: TOOL_DESCRIPTIONS.list, inputSchema: ListSchema.shape },
    wrap('list'),
  );
  server.registerTool(
    'log',
    { description: TOOL_DESCRIPTIONS.log, inputSchema: LogSchema.shape },
    wrap('log'),
  );
  server.registerTool(
    'write',
    { description: TOOL_DESCRIPTIONS.write, inputSchema: WriteSchema.shape },
    wrap('write'),
  );
  server.registerTool(
    'delete',
    { description: TOOL_DESCRIPTIONS.delete, inputSchema: DeleteSchema.shape },
    wrap('delete'),
  );
  server.registerTool(
    'tag',
    { description: TOOL_DESCRIPTIONS.tag, inputSchema: TagSchema.shape },
    wrap('tag'),
  );
  server.registerTool(
    'revert',
    { description: TOOL_DESCRIPTIONS.revert, inputSchema: RevertSchema.shape },
    wrap('revert'),
  );
  server.registerTool(
    'merge',
    { description: TOOL_DESCRIPTIONS.merge, inputSchema: MergeSchema.shape },
    wrap('merge'),
  );

  return server;
}

/**
 * Single-shot MCP request handler. Builds a fresh McpServer + stateless
 * StreamableHTTP transport per request; both are GC'd after the request
 * completes. Cost is small (no per-request DB or network connection;
 * just object construction).
 */
export async function handleMcpRequest(
  req: Request,
  res: Response,
  deps: HandlerDeps,
  ctx: RequestContext,
): Promise<void> {
  const server = buildMcpServer(deps, ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req as never, res as never, req.body);
  } finally {
    try {
      await transport.close?.();
    } catch {
      // ignore
    }
    try {
      await server.close?.();
    } catch {
      // ignore
    }
  }
}

export { TOOL_NAMES };
