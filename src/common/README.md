# @agentstudio/common

Shared common utilities and base classes for AgentStudio services.

## Overview

This package provides common infrastructure code that is shared across all AgentStudio services, reducing duplication and ensuring consistency.

## Features

### BaseServer Class

A base Express server class that provides:
- Common middleware (JSON parsing, request logging, error handling)
- Swagger/OpenAPI UI setup
- Health and readiness endpoints
- Graceful shutdown handling
- Standardized server lifecycle

**Usage:**

```typescript
import { BaseServer, BaseServerConfig } from '@agentstudio/common';

export interface MyServiceConfig extends BaseServerConfig {
  // Add service-specific config
}

export class MyService extends BaseServer {
  constructor(config: MyServiceConfig) {
    super(config);
  }

  protected setupRoutes(): void {
    super.setupRoutes(); // Call parent to setup Swagger/health
    
    // Add service-specific routes
    this.getApp().get('/api/v1/my-endpoint', this.handleMyEndpoint.bind(this));
  }

  async start(): Promise<void> {
    // Add service-specific startup logic
    await this.initializeSomething();
    
    // Call parent to start server
    await super.start();
  }
}
```

### Middleware

- **createErrorHandler**: Standardized error handling middleware
- **createRequestLogger**: Request logging middleware (suppresses health/ready logs unless debug)

### Configuration Utilities

- **parsePort**: Parse port from environment variable with validation
- **parseLogLevel**: Parse log level with validation
- **createShutdownHandler**: Create graceful shutdown handler

### Types

- **ErrorResponse**: Standard error response format
- **HealthResponse**: Health check response format
- **ReadyResponse**: Readiness check response format

## Building

```bash
cd src/common
npm install
npm run build
```

## Usage in Services

Services should add this as a local dependency:

```json
{
  "dependencies": {
    "@agentstudio/common": "file:../common"
  }
}
```

Then install dependencies:

```bash
npm install
```

## Architecture

The BaseServer class follows the Template Method pattern, allowing services to:
- Override `setupMiddleware()` to add custom middleware
- Override `setupRoutes()` to add custom routes
- Override `start()` to add startup logic
- Override `shutdown()` to add cleanup logic
- Override `handleHealth()` and `handleReady()` for custom health checks

