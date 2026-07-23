# AgentStudio Gateway

A Go-based API gateway service for the AgentStudio platform, built with [go-chi](https://github.com/go-chi/chi).

## Features

- HTTP router using go-chi
- Health and readiness endpoints
- Graceful shutdown
- Production-ready Docker image

## Development

### Prerequisites

- Go 1.21 or later

### Build

```bash
# Download dependencies
go mod download

# Build the binary
go build -o gateway .

# Run locally
./gateway
```

### Docker Build

The service can be built using the project Makefile:

```bash
# Build all services (including gateway)
make build

# Build Docker image for gateway
make docker-build-service SERVICE=gateway SERVICE_CONTEXT=nemo
```

## Configuration

The service can be configured via environment variables:

- `PORT`: Server port (default: 8080)

## Endpoints

- `GET /` - Service information
- `GET /health` - Health check endpoint
- `GET /ready` - Readiness check endpoint



