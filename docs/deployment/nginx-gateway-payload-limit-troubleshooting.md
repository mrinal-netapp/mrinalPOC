# NGINX Gateway Fabric (NGF) Payload Size Limit Troubleshooting

## Overview

For **NGINX Gateway Fabric (NGF)**, client body size limits should be configured using the `ClientSettingsPolicy` API, not ConfigMap. This policy applies to **all requests** going through the gateway, including `s3.agentstudio.local`.

**Reference:** [NGINX Gateway Fabric ClientSettingsPolicy API](https://docs.nginx.com/nginx-gateway-fabric/reference/api/#gateway.nginx.org%2fv1alpha1.ClientBody)

## Request Flow

```
Client → nginx-gateway → apigateway-service → s3gateway
```

All requests to `s3.agentstudio.local` go through this path, so the limits **should apply**.

## Verification Steps

### 1. Check ClientSettingsPolicy Exists (NGF - Recommended)

```bash
# Check if ClientSettingsPolicy exists
kubectl get clientsettingspolicy -n agentstudio-services

# View the ClientSettingsPolicy contents
kubectl get clientsettingspolicy -n agentstudio-services -o yaml
```

Expected output should include:
```yaml
spec:
  targetRef:
    kind: Gateway
    name: <gateway-name>
  body:
    maxSize: "200m"
    timeout: "600s"
```

### 2. Check ConfigMap (Legacy - Not Recommended for NGF)

If using the legacy ConfigMap approach (not recommended for NGF):

```bash
# Check if ConfigMap exists in the nginx-gateway namespace
kubectl get configmap -n nginx-gateway nginx-gateway-config

# View the ConfigMap contents
kubectl get configmap -n nginx-gateway nginx-gateway-config -o yaml
```

### 3. Check HTTPRoute Configuration

```bash
# Verify s3.agentstudio.local is in the HTTPRoute
kubectl get httproute -n agentstudio-services -o yaml | grep -A 5 "s3.agentstudio.local"
```

### 4. Check Gateway Status

```bash
# Verify Gateway is ready
kubectl get gateway -n agentstudio-services

# Check Gateway details
kubectl describe gateway -n agentstudio-services
```

### 5. Check Policy Status

```bash
# Check if the ClientSettingsPolicy is accepted
kubectl describe clientsettingspolicy -n agentstudio-services

# Look for status conditions indicating if the policy is applied
```

### 6. Check nginx-gateway Controller Logs

```bash
# Check if the controller is reading the ConfigMap
kubectl logs -n nginx-gateway deployment/nginx-gateway | grep -i "configmap\|client-max-body-size"
```

### 7. Test Upload Size Limit

Try uploading a file larger than 200MB to `s3.agentstudio.local`. If the limit is working, you should get a `413 Request Entity Too Large` error.

## Common Issues

### Issue 1: ClientSettingsPolicy Not Applied (NGF)

**Solution:** Ensure the Helm chart has `gateway.clientSettingsPolicy.enabled: true` in values.yaml:

```yaml
gateway:
  clientSettingsPolicy:
    enabled: true
    body:
      maxSize: "200m"
      timeout: "600s"
```

**Verify the policy:**
```bash
kubectl get clientsettingspolicy -n agentstudio-services
kubectl describe clientsettingspolicy -n agentstudio-services
```

### Issue 2: ConfigMap Not Applied (Legacy - Not Recommended for NGF)

**Solution:** If using legacy ConfigMap (not recommended for NGF), ensure the Helm chart has `gateway.configMap.enabled: true` in values.yaml:

```yaml
gateway:
  configMap:
    enabled: true
    name: nginx-gateway-config
    clientMaxBodySize: "200m"
```

### Issue 3: Wrong Namespace

**Solution:** Verify the ConfigMap is in the `nginx-gateway` namespace (or the namespace where the controller is running):

```bash
# Check controller namespace
kubectl get deployment -A | grep nginx-gateway

# Ensure ConfigMap is in the same namespace
kubectl get configmap -n <controller-namespace> nginx-gateway-config
```

### Issue 4: Policy Not Attached to Gateway

**Solution:** Verify the ClientSettingsPolicy `targetRef` points to the correct Gateway:

```bash
kubectl get clientsettingspolicy -n agentstudio-services -o yaml | grep -A 5 targetRef
```

The targetRef should match your Gateway name and namespace.

### Issue 5: Controller Version Compatibility

Ensure you're using NGINX Gateway Fabric (NGF) version that supports ClientSettingsPolicy. Check the [NGF documentation](https://docs.nginx.com/nginx-gateway-fabric/) for version requirements.

### Issue 6: ConfigMap Format (Legacy)

Ensure the ConfigMap uses the correct key format (kebab-case):

```yaml
data:
  client-max-body-size: "200m"  # ✅ Correct
  # NOT:
  # clientMaxBodySize: "200m"   # ❌ Wrong
```

## Increasing the Limit

To increase the payload size limit beyond 200MB:

### Using ClientSettingsPolicy (NGF - Recommended)

1. Update `values.yaml`:
```yaml
gateway:
  clientSettingsPolicy:
    enabled: true
    body:
      maxSize: "500m"  # Change to desired size
      timeout: "600s"
```

2. Upgrade Helm release:
```bash
make helm-services-upgrade-aks
```

3. Verify the policy is applied:
```bash
kubectl get clientsettingspolicy -n agentstudio-services
kubectl describe clientsettingspolicy -n agentstudio-services
```

### Using ConfigMap (Legacy - Not Recommended for NGF)

1. Update `values.yaml`:
```yaml
gateway:
  configMap:
    clientMaxBodySize: "500m"  # Change to desired size
```

2. Upgrade Helm release:
```bash
make helm-services-upgrade-aks
```

3. Restart the controller:
```bash
kubectl rollout restart deployment -n nginx-gateway nginx-gateway
```

## Manual ConfigMap Update

If Helm isn't applying the ConfigMap, you can update it manually:

```bash
kubectl patch configmap -n nginx-gateway nginx-gateway-config \
  --type merge \
  -p '{"data":{"client-max-body-size":"500m"}}'

# Then restart the controller
kubectl rollout restart deployment -n nginx-gateway nginx-gateway
```

## Verification

After making changes, verify the limit is applied:

```bash
# Check nginx configuration (if accessible)
kubectl exec -n nginx-gateway deployment/nginx-gateway -- cat /etc/nginx/nginx.conf | grep client_max_body_size
```

## Notes

- **For NGINX Gateway Fabric (NGF):** Use `ClientSettingsPolicy` API (recommended)
- **For legacy nginx-gateway:** ConfigMap may still work but is not the recommended approach
- The body size limit applies to **all** requests through the gateway, not just S3
- The limit is enforced at the nginx-gateway level, before requests reach apigateway-service
- Large file uploads may also need increased timeouts (configured: 600s)
- For very large files (>1GB), consider using multipart uploads or direct S3 access

## References

- [NGINX Gateway Fabric ClientSettingsPolicy API](https://docs.nginx.com/nginx-gateway-fabric/reference/api/#gateway.nginx.org%2fv1alpha1.ClientBody)
- [NGINX Gateway Fabric Documentation](https://docs.nginx.com/nginx-gateway-fabric/)
