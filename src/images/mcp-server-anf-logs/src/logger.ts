import pino from 'pino';

// Always log to stderr (fd 2) so the stdio transport's stdout stays clean
// JSON-RPC. pino writes to stdout by default, which would corrupt the stream.
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'anf-logs-mcp' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2)
);
