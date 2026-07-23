import express, { Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Sets up Swagger UI for the Express app
 * @param app Express application
 * @param openApiPath Path to the OpenAPI YAML file
 * @returns true if setup succeeded, false otherwise
 */
export function setupSwagger(
  app: express.Application,
  openApiPath: string
): boolean {
  try {
    const yamlContent = fs.readFileSync(openApiPath, 'utf8');
    const swaggerDocument = yaml.load(yamlContent) as any;

    // Serve OpenAPI spec as JSON/YAML
    app.get('/swagger.json', (req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/yaml');
      res.sendFile(path.resolve(openApiPath));
    });

    // Setup Swagger UI
    app.use('/swagger', swaggerUi.serve);
    app.get('/swagger', swaggerUi.setup(swaggerDocument));

    // Redirect /docs to /swagger
    app.get('/docs', (req: Request, res: Response) => {
      res.redirect('/swagger');
    });

    return true;
  } catch (error) {
    console.warn('Swagger UI setup failed:', error);
    return false;
  }
}

