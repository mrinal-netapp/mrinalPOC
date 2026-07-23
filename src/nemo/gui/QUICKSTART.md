# Quick Start Guide

## Development Setup

1. **Install dependencies:**
   ```bash
   cd src/nemo/gui
   npm install
   ```

2. **Start the development server:**
   ```bash
   npm run dev
   ```
   The UI will be available at `http://localhost:3000`

3. **Make sure the namespace service is running:**
   ```bash
   # In another terminal
   cd src/nemo/namespace-service
   npm run dev
   ```
   The service should be running on `http://localhost:8080`

## Building for Production

1. **Build the UI:**
   ```bash
   cd src/nemo/gui
   npm run build
   ```
   This creates a `dist` folder with the production build.

2. **Integrate with namespace service:**
   The namespace service will automatically serve the UI if the `dist` folder is placed at:
   ```
   src/nemo/namespace-service/dist/gui/dist
   ```
   
   Or you can copy the built files:
   ```bash
   cp -r src/nemo/gui/dist src/nemo/namespace-service/dist/gui/dist
   ```

3. **Access the UI:**
   Once integrated, the UI will be available at the same port as the namespace service (default: `http://localhost:8080`)

## Features

- **Namespace Management**: View, create, and delete namespaces
- **Ray Explorer**: See which deployments (rays) support each namespace with health status
- **S3 Explorer**: Browse buckets and objects with a file explorer interface

## API Configuration

The UI connects to the namespace service API. By default, it uses:
- Development: Proxy via Vite (`/api/v1` → `http://localhost:8080/api/v1`)
- Production: Set `VITE_API_BASE_URL` environment variable

## Troubleshooting

- **CORS errors**: Make sure the namespace service allows CORS or use the Vite proxy
- **UI not loading**: Check that the `dist` folder exists and is in the correct location
- **API errors**: Verify the namespace service is running and accessible

