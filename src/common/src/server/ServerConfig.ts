/**
 * Base server configuration interface
 */
export interface BaseServerConfig {
  port: number;
  logLevel: string;
}

/**
 * Extended server configuration with optional database
 */
export interface ServerConfig extends BaseServerConfig {
  database?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  };
}

