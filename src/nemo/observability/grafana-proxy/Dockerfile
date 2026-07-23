# Build stage — context is the repository root (same convention as other services)
FROM docker.repo.eng.netapp.com/golang:1.24-alpine AS builder

WORKDIR /build

COPY src/nemo/observability/grafana-proxy/go.mod src/nemo/observability/grafana-proxy/go.sum* \
     src/nemo/observability/grafana-proxy/

WORKDIR /build/src/nemo/observability/grafana-proxy

RUN go mod download

COPY src/nemo/observability/grafana-proxy/ .

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /grafana-proxy .

# Runtime stage — minimal image
FROM docker.repo.eng.netapp.com/alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /grafana-proxy /usr/local/bin/grafana-proxy

EXPOSE 8080

USER nobody
ENTRYPOINT ["/usr/local/bin/grafana-proxy"]
