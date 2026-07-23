#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import {
  listGcnvLogsTool,
  listGcnvErrorsTool,
  listGcnvEventsTool,
  gcnvLogSummaryTool,
} from './logs-tools.js';
import {
  listGcnvLogsHandler,
  listGcnvErrorsHandler,
  listGcnvEventsHandler,
  gcnvLogSummaryHandler,
} from './logs-handler.js';

const log = logger.child({ module: 'index' });

/**
 * Register the GCNV logs/errors/events tools on the given MCP server.
 *
 * Each tool is read-only and queries Google Cloud Logging scoped to the
 * NetApp Volumes service.
 */
export function registerTools(mcpServer: McpServer): void {
  mcpServer.registerTool(listGcnvLogsTool.name, listGcnvLogsTool, listGcnvLogsHandler);
  mcpServer.registerTool(listGcnvErrorsTool.name, listGcnvErrorsTool, listGcnvErrorsHandler);
  mcpServer.registerTool(listGcnvEventsTool.name, listGcnvEventsTool, listGcnvEventsHandler);
  mcpServer.registerTool(gcnvLogSummaryTool.name, gcnvLogSummaryTool, gcnvLogSummaryHandler);
}

async function main(): Promise<void> {
  const mcpServer = new McpServer({ name: 'gcnv-logs-mcp', version: '0.1.0' });
  registerTools(mcpServer);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log.info('GCNV logs MCP server listening on stdio');

  const reason = await new Promise<string>((resolve) => {
    process.on('SIGINT', () => resolve('SIGINT'));
    process.on('SIGTERM', () => resolve('SIGTERM'));
    transport.onclose = () => resolve('stdio transport closed');
  });

  // Force a clean exit. When the gateway tears down this stdio child (stdin EOF
  // on session reap, or SIGTERM on pod shutdown), lazily-created clients — most
  // notably the @google-cloud/logging gRPC client — keep open handles that
  // would otherwise keep the event loop alive and leave the process running
  // forever. Under a per-session gateway that accumulates until the pod hits
  // its memory limit, so we exit explicitly here.
  log.info({ reason }, 'GCNV logs MCP server shutting down');
  process.exit(0);
}

main().catch((error) => {
  log.fatal({ err: error }, 'Fatal server error');
  process.exit(1);
});
