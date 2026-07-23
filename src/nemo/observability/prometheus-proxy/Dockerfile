# Build stage — context is the repository root (same convention as grafana-proxy).
FROM docker.repo.eng.netapp.com/golang:1.24-alpine AS builder

WORKDIR /build

COPY src/nemo/observability/prometheus-proxy/go.mod \
     src/nemo/observability/prometheus-proxy/

WORKDIR /build/src/nemo/observability/prometheus-proxy

RUN go mod download

COPY src/nemo/observability/prometheus-proxy/ .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /prometheus-proxy .

# Runtime stage — minimal image.
FROM docker.repo.eng.netapp.com/alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /prometheus-proxy /usr/local/bin/prometheus-proxy

EXPOSE 9091

USER nobody

ENTRYPOINT ["/usr/local/bin/prometheus-proxy"]
