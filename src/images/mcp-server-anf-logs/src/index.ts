#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './logger.js';
import {
  listAnfLogsTool,
  listAnfErrorsTool,
  listAnfEventsTool,
  anfLogSummaryTool,
} from './logs-tools.js';
import {
  listAnfLogsHandler,
  listAnfErrorsHandler,
  listAnfEventsHandler,
  anfLogSummaryHandler,
} from './logs-handler.js';

const log = logger.child({ module: 'index' });

/**
 * Register the ANF logs/errors/events tools on the given MCP server.
 *
 * Each tool is read-only and queries the Azure Monitor Activity Log scoped to
 * the Microsoft.NetApp resource provider.
 */
export function registerTools(mcpServer: McpServer): void {
  mcpServer.registerTool(listAnfLogsTool.name, listAnfLogsTool, listAnfLogsHandler);
  mcpServer.registerTool(listAnfErrorsTool.name, listAnfErrorsTool, listAnfErrorsHandler);
  mcpServer.registerTool(listAnfEventsTool.name, listAnfEventsTool, listAnfEventsHandler);
  mcpServer.registerTool(anfLogSummaryTool.name, anfLogSummaryTool, anfLogSummaryHandler);
}

async function main(): Promise<void> {
  const mcpServer = new McpServer({ name: 'anf-logs-mcp', version: '0.1.0' });
  registerTools(mcpServer);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log.info('ANF logs MCP server listening on stdio');

  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    transport.onclose = shutdown;
  });
}

main().catch((error) => {
  log.fatal({ err: error }, 'Fatal server error');
  process.exit(1);
});
