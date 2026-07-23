/**
 * Shared HTTP test harness: build an express app around a router and issue
 * real (loopback) requests against an ephemeral port. Generalizes the
 * `listen()` helper that was duplicated across the *.routes.unit.test.ts files.
 */
import express, { type Express, type Router, type RequestHandler } from 'express';
import http from 'node:http';

export interface TestResponse {
  status: number;
  body: any;
  text: string;
  headers: http.IncomingHttpHeaders;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

/** Issue a single HTTP request against `app` and resolve the parsed response. */
export function request(
  app: Express,
  method: string,
  urlPath: string,
  options: RequestOptions = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('failed to bind test server'));
      }
      const payload =
        options.body !== undefined ? JSON.stringify(options.body) : undefined;
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      if (payload !== undefined) {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(payload));
      }
      const req = http.request(
        { hostname: '127.0.0.1', port: addr.port, path: urlPath, method, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            let body: any = null;
            if (text) {
              try {
                body = JSON.parse(text);
              } catch {
                body = { _raw: text };
              }
            }
            resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  });
}

export interface MountOptions {
  /** Base path the router is mounted under (e.g. '/api/v1/projects/:projectId/agents'). */
  basePath: string;
  router: Router | RequestHandler;
  /** Middleware to run before the router (e.g. to seed req.params / req.user). */
  pre?: RequestHandler[];
  /** Express JSON body limit. */
  jsonLimit?: string;
}

/**
 * Build an app that mounts `router` under `basePath` with JSON parsing and a
 * standard error handler so thrown errors surface as JSON instead of HTML.
 */
export function buildApp(options: MountOptions): Express {
  const app = express();
  app.use(express.json({ limit: options.jsonLimit ?? '4mb' }));
  for (const mw of options.pre ?? []) app.use(mw);
  app.use(options.basePath, options.router as RequestHandler);
  // Minimal terminal error handler mirroring middleware/errorHandler shape.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    res.status(status).json({ error: err?.message ?? 'Internal Server Error' });
  });
  return app;
}

/** Seed `req.user` and project headers so auth-aware handlers behave. */
export function withUser(user: Record<string, unknown> = { sub: 'test-user' }): RequestHandler {
  return (req, _res, next) => {
    (req as any).user = user;
    if (!req.headers.authorization) {
      req.headers.authorization = 'Bearer test-token';
    }
    next();
  };
}
