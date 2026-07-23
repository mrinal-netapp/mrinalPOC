# AgentStudio

Modern, professional GUI for managing namespaces, exploring rays, and browsing S3 objects with an Azure-like user experience.

## Features

- **Namespace Management**: Create, view, edit, and delete namespaces
- **Ray Explorer**: View deployments (rays) supporting a namespace with health status and routing information
- **S3 Explorer**: Browse buckets and objects with a file explorer-like interface

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The application will be available at `http://localhost:3000`

### Build

```bash
npm run build
```

## Configuration

### API Base URL

Set the API base URL via environment variable:

```bash
VITE_API_BASE_URL=http://localhost:8080/api/v1 npm run dev
```

By default, it uses `/api/v1` which works with the Vite proxy configuration.

### Base Path (for Gateway Deployment)

When deploying behind a gateway (e.g., at `/console`), set the base path at **build time**:

```bash
# For Docker builds
docker build --build-arg VITE_BASE_PATH=/console -f Dockerfile .

# Or via environment variable when using make
VITE_BASE_PATH=/console make docker-build-service SERVICE=gui
```

The base path:
- Must be set at build time (cannot be changed at runtime)
- Prefixes all asset URLs (JS, CSS, images, etc.)
- Is used by React Router for client-side routing
- Defaults to `/` for standalone mode
- Should be `/console` when accessed via gateway at `/console`

**Important**: The base path used at build time must match the gateway route path.

## Architecture

- **React 18** with TypeScript
- **Fluent UI React** for Azure-like components
- **React Router** for navigation
- **Axios** for API calls
- **Vite** for fast development and building

## Project Structure

```
src/
  components/     # Reusable UI components
  pages/         # Page components
  services/      # API service layer
  App.tsx        # Main app component
  main.tsx       # Entry point
```

