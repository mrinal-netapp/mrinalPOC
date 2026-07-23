import express, { Application, Request, Response } from 'express';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { BaseServerConfig } from './ServerConfig';
import { createErrorHandler } from '../middleware/errorHandler';
import { setupSwagger } from '../swagger/swaggerSetup';
import { HealthResponse, ReadyResponse } from '../types/common';
import { requestLoggingMiddleware, get_logger } from '../observability';

/**
 * Base server class with common functionality
 * Extend this class to create service-specific servers
 * @template TConfig - The configuration type (must extend BaseServerConfig)
 */
export abstract class BaseServer<TConfig extends BaseServerConfig = BaseServerConfig> {
  protected app: Application;
  protected config: TConfig;
  protected server: http.Server | null = null;

  constructor(config: TConfig) {
    this.config = config;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup common middleware
   * Override in subclasses to add service-specific middleware
   */
  protected setupMiddleware(): void {
    // JSON body parser (can be overridden for services that need raw body)
    this.app.use(express.json());

    // Observability: request ID + OTel span context + structured JSON logging
    this.app.use(requestLoggingMiddleware);

    // Error handling
    this.app.use(createErrorHandler(this.config.logLevel));
  }

  /**
   * Setup common routes
   * Override in subclasses to add service-specific routes
   */
  protected setupRoutes(): void {
    // Setup Swagger UI if OpenAPI spec exists
    // Try multiple possible paths
    const possiblePaths = [
      path.join(__dirname, '../openapi.yaml'), // dist/server/openapi.yaml
      path.join(__dirname, '../../openapi.yaml'), // dist/openapi.yaml
      path.join(process.cwd(), 'src/openapi.yaml'),
      path.join(process.cwd(), 'dist/openapi.yaml')
    ];

    let swaggerSetup = false;
    for (const swaggerPath of possiblePaths) {
      try {
        if (fs.existsSync(swaggerPath)) {
          setupSwagger(this.app, swaggerPath);
          swaggerSetup = true;
          break;
        }
      } catch (e) {
        // Continue to next path
      }
    }

    if (!swaggerSetup) {
      get_logger().warn('swagger_spec_not_found', { message: 'Swagger UI will not be available' });
    }

    // Health endpoints
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/ready', this.handleReady.bind(this));
  }

  /**
   * Handle health check endpoint
   * Override in subclasses to add service-specific health checks
   */
  protected handleHealth(req: Request, res: Response): void {
    const response: HealthResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString()
    };
    res.json(response);
  }

  /**
   * Handle readiness check endpoint
   * Override in subclasses to add service-specific readiness checks
   */
  protected handleReady(req: Request, res: Response): void {
    const response: ReadyResponse = {
      status: 'ready',
      timestamp: new Date().toISOString()
    };
    res.json(response);
  }

  /**
   * Start the server
   * Override in subclasses to add service-specific startup logic
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.config.port, () => {
        get_logger().info('server_listening', { port: this.config.port });
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  /**
   * Shutdown the server gracefully
   * Override in subclasses to add service-specific cleanup logic
   */
  async shutdown(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          get_logger().info('server_closed', {});
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the Express application instance
   * Useful for adding routes or middleware after construction
   */
  getApp(): Application {
    return this.app;
  }
}

