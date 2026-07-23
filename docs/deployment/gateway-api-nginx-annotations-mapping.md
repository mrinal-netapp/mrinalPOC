# Gateway API - NGINX Annotations Mapping

This document maps NGINX Ingress Controller annotations to Gateway API equivalents.

## Overview

Gateway API is the future of Kubernetes ingress, replacing the deprecated Ingress NGINX. However, Gateway API implementations may not support all NGINX-specific annotations directly. Some features need to be configured at different levels or may require implementation-specific configuration.

## Annotation Mapping

### Timeouts

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"`
- `nginx.ingress.kubernetes.io/proxy-send-timeout: "20"`
- `nginx.ingress.kubernetes.io/proxy-read-timeout: "20"`

**Gateway API Equivalent:**
- Configure via GatewayClass Policy or Gateway controller ConfigMap
- Some implementations support timeout configuration at Gateway or HTTPRoute level
- Gateway NGINX: Configure via GatewayClass parameters or controller ConfigMap

**Status:** Requires GatewayClass-level or controller-level configuration

### Keepalive Connections

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/upstream-keepalive-connections: "128"`
- `nginx.ingress.kubernetes.io/upstream-keepalive-timeout: "60"`
- `nginx.ingress.kubernetes.io/upstream-keepalive-requests: "1000"`

**Gateway API Equivalent:**
- Configure via GatewayClass Policy or Gateway controller ConfigMap
- Gateway NGINX: Configure via controller ConfigMap

**Status:** Requires GatewayClass-level or controller-level configuration

### Retry Logic

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/proxy-next-upstream: "error timeout http_502 http_503 http_504"`
- `nginx.ingress.kubernetes.io/proxy-next-upstream-timeout: "10"`
- `nginx.ingress.kubernetes.io/proxy-next-upstream-tries: "3"`

**Gateway API Equivalent:**
- Use HTTPRoute `filters` with retry policies (if supported by implementation)
- Gateway NGINX: May support retry via HTTPRoute filters or controller ConfigMap

**Status:** Implementation-dependent, may require controller-level configuration

### Rate Limiting

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/limit-rps: "100"`
- `nginx.ingress.kubernetes.io/limit-connections: "50"`

**Gateway API Equivalent:**
- Use Gateway API Policy attachments (e.g., `RateLimitPolicy`)
- Gateway NGINX: May require controller-level configuration or Policy CRD

**Status:** Requires Gateway API Policy or controller-level configuration

### HTTP/2

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/use-http2: "true"`

**Gateway API Equivalent:**
- Configure at Gateway listener level (protocol support)
- Gateway NGINX: HTTP/2 is typically enabled by default for HTTPS listeners

**Status:** Supported at Gateway listener level

### Buffer Sizes

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/proxy-buffer-size: "32k"`
- `nginx.ingress.kubernetes.io/proxy-buffers-number: "16"`
- `nginx.ingress.kubernetes.io/proxy-busy-buffers-size: "64k"`
- `nginx.ingress.kubernetes.io/proxy-request-buffering: "on"`
- `nginx.ingress.kubernetes.io/proxy-response-buffering: "on"`

**Gateway API Equivalent:**
- Configure via GatewayClass Policy or Gateway controller ConfigMap
- Gateway NGINX: Configure via controller ConfigMap

**Status:** Requires GatewayClass-level or controller-level configuration

### Body Size Limits

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/proxy-body-size: "200m"`
- `nginx.ingress.kubernetes.io/client-max-body-size: "200m"`

**Gateway API Equivalent:**
- May be supported via Gateway API Policy or controller ConfigMap
- Gateway NGINX: Configure via controller ConfigMap

**Status:** Requires controller-level configuration

### Header Forwarding

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/use-forwarded-headers: "true"`
- `nginx.ingress.kubernetes.io/compute-full-forwarded-for: "true"`

**Gateway API Equivalent:**
- Gateway API handles header forwarding differently
- May require controller-level configuration
- Gateway NGINX: Configure via controller ConfigMap

**Status:** Requires controller-level configuration

### Connection Keepalive

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/keepalive-timeout: "75"`
- `nginx.ingress.kubernetes.io/keepalive-requests: "1000"`

**Gateway API Equivalent:**
- Configure via GatewayClass Policy or Gateway controller ConfigMap
- Gateway NGINX: Configure via controller ConfigMap

**Status:** Requires GatewayClass-level or controller-level configuration

### SSL Redirect

**NGINX Annotations:**
- `nginx.ingress.kubernetes.io/ssl-redirect: "false"`

**Gateway API Equivalent:**
- Configure via HTTPRoute filters (e.g., `RequestRedirect` filter)
- Or handle at application level

**Status:** Supported via HTTPRoute filters

## Configuration Levels

### GatewayClass Level
- Cluster-wide configuration
- Applies to all Gateways using the GatewayClass
- Configure via GatewayClass parameters or controller ConfigMap

### Gateway Level
- Per-Gateway configuration
- Limited support in Gateway API specification
- Some implementations may support Gateway-level annotations

### HTTPRoute Level
- Per-route configuration
- Supports filters for request/response modification
- Retry, redirect, and other routing policies

### Controller Level
- Implementation-specific configuration
- Gateway NGINX: Configure via ConfigMap in controller namespace
- Applies to all Gateways managed by the controller

## Migration Strategy

1. **Identify Required Features**: List all NGINX annotations currently used
2. **Map to Gateway API**: Use this document to identify equivalents
3. **Configure at Appropriate Level**: 
   - GatewayClass/Controller level for infrastructure settings
   - HTTPRoute level for routing policies
4. **Test Functionality**: Verify all features work as expected
5. **Document Implementation-Specific Config**: Note any controller-specific settings

## Gateway NGINX Controller Configuration

For Gateway NGINX, many NGINX-specific features can be configured via the controller ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nginx-gateway-config
  namespace: nginx-gateway
data:
  # Timeouts
  proxy-connect-timeout: "10s"
  proxy-send-timeout: "20s"
  proxy-read-timeout: "20s"
  
  # Keepalive
  upstream-keepalive-connections: "128"
  upstream-keepalive-timeout: "60s"
  upstream-keepalive-requests: "1000"
  
  # Buffers
  proxy-buffer-size: "32k"
  proxy-buffers-number: "16"
  proxy-busy-buffers-size: "64k"
  
  # Body size
  client-max-body-size: "200m"
  
  # HTTP/2
  http2: "true"
```

## References

- [Gateway API Specification](https://gateway-api.sigs.k8s.io/)
- [Gateway NGINX Documentation](https://github.com/nginxinc/nginx-kubernetes-gateway)
- [NGINX Ingress Controller Annotations](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)
