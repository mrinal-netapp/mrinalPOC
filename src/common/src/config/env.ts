/**
 * Parses port from environment variable with default
 */
export function parsePort(envPort: string | undefined, defaultPort: number = 8080): number {
  if (!envPort) {
    return defaultPort;
  }
  const port = parseInt(envPort, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.warn(`Invalid port "${envPort}", using default ${defaultPort}`);
    return defaultPort;
  }
  return port;
}

/**
 * Parses log level from environment variable with default
 */
export function parseLogLevel(envLogLevel: string | undefined, defaultLevel: string = 'info'): string {
  const validLevels = ['debug', 'info', 'warn', 'error'];
  if (!envLogLevel) {
    return defaultLevel;
  }
  const level = envLogLevel.toLowerCase();
  if (validLevels.includes(level)) {
    return level;
  }
  console.warn(`Invalid log level "${envLogLevel}", using default "${defaultLevel}"`);
  return defaultLevel;
}

/**
 * Creates a graceful shutdown handler
 */
export function createShutdownHandler(
  shutdownFn: () => Promise<void>
): () => void {
  return async () => {
    console.log('Shutting down server...');
    try {
      await shutdownFn();
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };
}

