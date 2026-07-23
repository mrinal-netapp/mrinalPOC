# Local Development Setup for Workspace Subdomain Routing (macOS)

## Overview

This guide explains how to set up the infrastructure requirements for workspace subdomain routing in a local development environment on macOS. This covers Phase 1 items from the main design document.

**URL Contract**: Workspace URLs follow the pattern `ws-<id>.<endpoint>` (e.g., `ws-abc12345.agentstudio.local`).

**Domain Configuration**: This guide uses `agentstudio.local` as the base domain for local development, with workspace subdomains at `ws-<id>.agentstudio.local`. The wildcard DNS/cert pattern `*.agentstudio.local` naturally covers these since `ws-<id>` is a single DNS label.

---

## Prerequisites

- macOS (tested on macOS 12+)
- Homebrew (for installing tools)
- Docker Desktop (if using containerized services)
- Go 1.21+ (for running the Gateway service locally)
- Node.js and npm/yarn (for running frontend services locally)
- Admin/sudo access (for modifying `/etc/hosts` and DNS configuration)

---

## Phase 1: Infrastructure Setup for Local Development

### 1. DNS Configuration

#### Step 1: Register Base Domain (agentstudio.local)

First, we need to register `agentstudio.local` to resolve to `127.0.0.1`. This allows all subdomains to work automatically.

**Edit /etc/hosts:**

```bash
sudo nano /etc/hosts
```

**Add base domain entry:**

```text
127.0.0.1    agentstudio.local
```

**Verify base domain resolution:**

```bash
ping -c 1 agentstudio.local
# Should resolve to 127.0.0.1
```

#### Option A: /etc/hosts File (Simple but Limited)

You can add individual workspace subdomains to `/etc/hosts`:

```bash
sudo nano /etc/hosts
```

Add entries for specific workspaces:

```text
127.0.0.1    ws-test1.agentstudio.local
127.0.0.1    ws-test2.agentstudio.local
127.0.0.1    ws-abc12345.agentstudio.local
127.0.0.1    ws-xyz98765.agentstudio.local
```

**Note**: You'll need to add entries for each workspace you want to test. For dynamic testing, see Option B below.

**Limitations**:

- `/etc/hosts` doesn't support true wildcards
- You must add entries for each workspace subdomain manually
- For dynamic workspace creation, use Option B

---

#### Option B: Local DNS Server with dnsmasq (Recommended for Dynamic Workspaces)

This approach allows true wildcard DNS resolution for `*.agentstudio.local`, which covers all `ws-<id>.agentstudio.local` subdomains.

**Step 1: Install dnsmasq**

```bash
brew install dnsmasq
```

**Step 2: Configure dnsmasq**

Create configuration file:

```bash
mkdir -p $(brew --prefix)/etc
cat > $(brew --prefix)/etc/dnsmasq.conf <<EOF
# Listen on localhost
listen-address=127.0.0.1

# Wildcard DNS for all agentstudio.local subdomains (covers ws-*.agentstudio.local)
address=/agentstudio.local/127.0.0.1

# Log queries for debugging
log-queries
log-facility=/tmp/dnsmasq.log
EOF
```

**Step 3: Start dnsmasq**

```bash
# Start dnsmasq service
sudo brew services start dnsmasq

# Or run manually
sudo dnsmasq --no-daemon
```

**Step 4: Configure macOS to use dnsmasq**

Create resolver configuration for agentstudio.local:

```bash
sudo mkdir -p /etc/resolver
sudo tee /etc/resolver/agentstudio.local <<EOF
nameserver 127.0.0.1
EOF
```

**Step 5: Verify DNS Resolution**

```bash
# Test base domain
dig @127.0.0.1 agentstudio.local

# Test workspace subdomains
dig @127.0.0.1 ws-test1.agentstudio.local
dig @127.0.0.1 ws-abc12345.agentstudio.local

# Test with curl
curl -v http://ws-test1.agentstudio.local:8080
```

**Troubleshooting**:
- If DNS doesn't work, flush DNS cache: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
- Check dnsmasq logs: `tail -f /tmp/dnsmasq.log`
- Verify dnsmasq is running: `ps aux | grep dnsmasq`
- Verify resolver config: `cat /etc/resolver/agentstudio.local`

---

### 2. SSL Certificate Setup

For local development, we'll use `mkcert` to create a trusted wildcard certificate for `*.agentstudio.local`. This covers all workspace subdomains (`ws-<id>.agentstudio.local`) since `ws-<id>` is a single DNS label.

#### Step 1: Install mkcert

```bash
brew install mkcert
```

#### Step 2: Install Local CA

This installs mkcert's local CA into the system trust store (automatically trusted by browsers):

```bash
mkcert -install
```

You should see output like:

```text
Created a new local CA at "/Users/yourname/Library/Application Support/mkcert" 
The local CA is now installed in the system trust store! ⚡️
```

#### Step 3: Generate Wildcard Certificate

Create certificate directory and generate certificates:

```bash
mkdir -p ~/agentstudio-dev-certs
cd ~/agentstudio-dev-certs

# Generate wildcard certificate covering all subdomains
mkcert "*.agentstudio.local" "agentstudio.local" "localhost" "127.0.0.1"
```

This creates:

- `_wildcard.agentstudio.local+3.pem` (certificate)
- `_wildcard.agentstudio.local+3-key.pem` (private key)

The `*.agentstudio.local` wildcard covers all workspace subdomains (`ws-abc12345.agentstudio.local`, `ws-xyz98765.agentstudio.local`, etc.).

#### Step 4: Rename Certificates (Optional, for easier reference)

```bash
cd ~/agentstudio-dev-certs
mv _wildcard.agentstudio.local+3.pem wildcard-agentstudio-local-cert.pem
mv _wildcard.agentstudio.local+3-key.pem wildcard-agentstudio-local-key.pem
```

#### Step 5: Verify Certificate

```bash
# View certificate details
openssl x509 -in ~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem -text -noout

# Test certificate (after starting Gateway)
openssl s_client -connect ws-test1.agentstudio.local:8443 \
  -servername ws-test1.agentstudio.local
```

**Advantages of mkcert**:

- Automatically trusted by all browsers (Chrome, Firefox, Safari, Edge)
- No manual CA trust setup needed
- Simpler workflow
- Works out of the box

---

### 3. Gateway Configuration

#### Step 1: Update Gateway to Use SSL

The Gateway service (`src/nemo/apigateway-service/`, Go module `agentstudio/nemo/gateway`) can be configured with TLS for local development:

```go
// TLS configuration loaded from environment
tlsCert := os.Getenv("SSL_CERT_PATH") // ~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem
tlsKey := os.Getenv("SSL_KEY_PATH")   // ~/agentstudio-dev-certs/wildcard-agentstudio-local-key.pem

srv := &http.Server{
    Addr:    ":8443",
    Handler: gateway,
}
srv.ListenAndServeTLS(tlsCert, tlsKey)
```

#### Step 2: Environment Variables

Create `.env` file in `src/nemo/apigateway-service/`:

```bash
# SSL Certificate Paths
SSL_KEY_PATH=~/agentstudio-dev-certs/wildcard-agentstudio-local-key.pem
SSL_CERT_PATH=~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem

# Ports
PORT=8080
HTTPS_PORT=8443

# Workspace Subdomain Configuration
WORKSPACE_SUBDOMAIN_BASE=agentstudio.local
WORKSPACE_COOKIE_DOMAIN=.agentstudio.local
ENABLE_SUBDOMAIN_ROUTING=true

# Development Mode
ENV=development
```

---

### 4. Load Balancer / Ingress (Local Development)

The setup depends on your deployment method:

#### Option A: Direct Gateway (Non-Kubernetes)

Just run the Gateway on HTTPS port 8443. All requests go directly to it.

#### Option B: Kubernetes with kind (Recommended for K8s Development)

If you're using a local Kubernetes cluster (kind, minikube, etc.), you'll need to set up an Ingress controller and configure it properly. See the [Kubernetes (kind) Setup](#kubernetes-kind-setup) section below for detailed instructions.

#### Option C: Kubernetes Ingress (If Using K8s Locally)

**Create Ingress resource:**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: workspace-ingress-local
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - "*.agentstudio.local"
      secretName: nemo-gateway-tls-local
  rules:
    - host: "*.agentstudio.local"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gateway
                port:
                  number: 8080
```

**Create TLS secret:**

```bash
kubectl create secret tls nemo-gateway-tls-local \
  --cert=~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem \
  --key=~/agentstudio-dev-certs/wildcard-agentstudio-local-key.pem
```

---

## Complete Setup Scripts

### For Direct Gateway (Non-Kubernetes)

Here's a complete setup script for running the Gateway directly:

```bash
#!/bin/bash
set -e

echo "Setting up workspace subdomain routing for local development..."
echo "Using domain: agentstudio.local"
echo "URL pattern: ws-<id>.agentstudio.local"

# 1. Register base domain in /etc/hosts
echo "Registering agentstudio.local in /etc/hosts..."
if ! grep -q "agentstudio.local" /etc/hosts; then
    echo "127.0.0.1    agentstudio.local" | sudo tee -a /etc/hosts
    echo "✅ Added agentstudio.local to /etc/hosts"
else
    echo "✅ agentstudio.local already in /etc/hosts"
fi

# 2. Install dnsmasq if not installed
if ! command -v dnsmasq &> /dev/null; then
    echo "Installing dnsmasq..."
    brew install dnsmasq
fi

# 3. Configure dnsmasq
echo "Configuring dnsmasq..."
mkdir -p $(brew --prefix)/etc
cat > $(brew --prefix)/etc/dnsmasq.conf <<EOF
listen-address=127.0.0.1
address=/agentstudio.local/127.0.0.1
log-queries
log-facility=/tmp/dnsmasq.log
EOF

# 4. Start dnsmasq
echo "Starting dnsmasq..."
sudo brew services restart dnsmasq

# 5. Configure resolver for agentstudio.local
echo "Configuring DNS resolver for agentstudio.local..."
sudo mkdir -p /etc/resolver
sudo tee /etc/resolver/agentstudio.local <<EOF
nameserver 127.0.0.1
EOF

# 6. Install mkcert if not installed
if ! command -v mkcert &> /dev/null; then
    echo "Installing mkcert..."
    brew install mkcert
fi

# 7. Install mkcert local CA
echo "Installing mkcert local CA..."
mkcert -install

# 8. Create SSL certificates directory
echo "Creating SSL certificates..."
mkdir -p ~/agentstudio-dev-certs
cd ~/agentstudio-dev-certs

# 9. Generate wildcard certificate with mkcert
echo "Generating wildcard SSL certificate..."
mkcert "*.agentstudio.local" "agentstudio.local" "localhost" "127.0.0.1"

# 10. Rename certificates for easier reference
if [ -f "_wildcard.agentstudio.local+3.pem" ]; then
    mv _wildcard.agentstudio.local+3.pem wildcard-agentstudio-local-cert.pem
    mv _wildcard.agentstudio.local+3-key.pem wildcard-agentstudio-local-key.pem
    echo "✅ Certificates renamed"
fi

# 11. Flush DNS cache
echo "Flushing DNS cache..."
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Update Gateway to use SSL certificates"
echo "2. Set environment variables for certificate paths"
echo "3. Test with: curl https://ws-test1.agentstudio.local:8443"
echo ""
echo "Certificate location: ~/agentstudio-dev-certs/"
echo "  - Certificate: wildcard-agentstudio-local-cert.pem"
echo "  - Key: wildcard-agentstudio-local-key.pem"
echo ""
echo "Test DNS resolution:"
echo "  dig @127.0.0.1 ws-test1.agentstudio.local"
```

Save as `scripts/setup-direct-gateway.sh`, make executable, and run:

```bash
chmod +x scripts/setup-direct-gateway.sh
./scripts/setup-direct-gateway.sh
```

### For Kubernetes (kind)

A helper script is available for kind clusters that automates all the setup:

```bash
# Run the kind setup script
./scripts/setup-kind-workspace-routing.sh
```

This script will:

1. Register `agentstudio.local` in `/etc/hosts`
2. Install and configure mkcert CA
3. Generate wildcard SSL certificates
4. Create Kubernetes namespace
5. Install NGINX Ingress Controller
6. Create TLS secret from certificates
7. Create Ingress resource that routes all traffic through Gateway:
   - `agentstudio.local` → Gateway (port 8080, which proxies to Glass Console)
   - `*.agentstudio.local` → Gateway (port 8080, for workspace subdomains)
8. Configure port mappings and verify setup

**Manual setup**: See the [Kubernetes (kind) Setup](#kubernetes-kind-setup) section below for step-by-step instructions.

---

## Testing the Setup

### Test DNS Resolution

```bash
# Test base domain
dig @127.0.0.1 agentstudio.local

# Test workspace subdomains
dig @127.0.0.1 ws-test1.agentstudio.local
dig @127.0.0.1 ws-abc12345.agentstudio.local

# Test with ping
ping -c 1 ws-test1.agentstudio.local

# Test with curl (HTTP)
curl -v http://ws-test1.agentstudio.local:8080

# Test with curl (HTTPS - should work without -k flag since mkcert is trusted)
curl https://ws-test1.agentstudio.local:8443
```

### Test SSL Certificate

```bash
# View certificate details
openssl x509 -in ~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem -text -noout

# Test certificate connection
openssl s_client -connect ws-test1.agentstudio.local:8443 \
  -servername ws-test1.agentstudio.local
```

### Test in Browser

1. Open browser and navigate to: `https://ws-test1.agentstudio.local:8443`
2. Certificate should be automatically trusted (no security warnings with mkcert)
3. Should connect successfully

---

## Troubleshooting

### DNS Not Resolving

**Problem**: `ws-test1.agentstudio.local` doesn't resolve

**Solutions**:

1. Check dnsmasq is running: `ps aux | grep dnsmasq`
2. Check dnsmasq logs: `tail -f /tmp/dnsmasq.log`
3. Flush DNS cache: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`
4. Verify resolver config: `cat /etc/resolver/agentstudio.local`
5. Verify base domain in /etc/hosts: `grep agentstudio.local /etc/hosts`
6. Test with dig: `dig @127.0.0.1 ws-test1.agentstudio.local`

### SSL Certificate Errors

**Problem**: Browser shows "Not Secure" or certificate error

**Solutions**:

1. Verify mkcert CA is installed: `mkcert -CAROOT` (should show path)
2. Reinstall mkcert CA: `mkcert -install`
3. Verify certificate was generated correctly: `ls -la ~/agentstudio-dev-certs/`
4. Regenerate certificate if needed: `cd ~/agentstudio-dev-certs && mkcert "*.agentstudio.local" "agentstudio.local" "localhost" "127.0.0.1"`
5. Restart browser

### Port Already in Use

**Problem**: Port 8443 already in use

**Solutions**:

1. Find process using port: `lsof -i :8443`
2. Kill process or change port in environment variables
3. Update Gateway port configuration

### dnsmasq Not Starting

**Problem**: dnsmasq service fails to start

**Solutions**:

1. Check configuration: `cat $(brew --prefix)/etc/dnsmasq.conf`
2. Check for syntax errors
3. Try running manually: `sudo dnsmasq --no-daemon`
4. Check logs: `tail -f /tmp/dnsmasq.log`

---

## Kubernetes (kind) Setup

If you're using a local Kubernetes cluster with kind, the setup requires additional steps to configure Ingress and expose services properly.

**Quick Start**: Use the automated script: `./scripts/setup-kind-workspace-routing.sh`

For manual setup, follow the steps below:

### Step 1: Install Ingress Controller

For kind, we'll use the Gateway NGINX Controller (Gateway API):

```bash
# Install Gateway API CRDs and Gateway NGINX controller
make install-gateway-api

# Or manually:
# Install Gateway API CRDs
kubectl apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.4.1/standard-install.yaml

# Install Gateway NGINX controller
helm repo add nginx-gateway https://nginxinc.github.io/nginx-kubernetes-gateway
helm repo update
helm install nginx-gateway nginx-gateway/nginx-gateway \
  --namespace nginx-gateway \
  --create-namespace \
  --set service.type=NodePort \
  --set service.nodePorts.http=30080 \
  --set service.nodePorts.https=30443
```

**Wait for Gateway controller to be ready:**

```bash
kubectl wait --namespace nginx-gateway \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s
```

### Step 2: Create Kubernetes TLS Secret

Create a TLS secret from the mkcert certificates:

```bash
# Create secret in your namespace (e.g., nemo)
kubectl create namespace nemo  # if not exists

kubectl create secret tls nemo-gateway-tls \
  --namespace=nemo \
  --cert=~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem \
  --key=~/agentstudio-dev-certs/wildcard-agentstudio-local-key.pem
```

### Step 3: Create Ingress Resource

Create an Ingress resource that routes all traffic through the Gateway:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agentstudio-ingress
  namespace: nemo
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "false"
    nginx.ingress.kubernetes.io/use-regex: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - "*.agentstudio.local"
        - "agentstudio.local"
      secretName: nemo-gateway-tls
  rules:
    # Main domain routes to Gateway (which proxies to Glass Console)
    - host: "agentstudio.local"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gateway
                port:
                  number: 8080
    # Workspace subdomains route to Gateway
    - host: "*.agentstudio.local"
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: gateway
                port:
                  number: 8080
```

Save as `agentstudio-ingress.yaml` and apply:

```bash
kubectl apply -f agentstudio-ingress.yaml
```

**Routing Summary**:

- `agentstudio.local` → `gateway:8080` (Gateway proxies to Glass Console internally)
- `ws-<id>.agentstudio.local` → `gateway:8080` (Workspace subdomains)

**Note**: All traffic flows through the Gateway service, which provides a unified entry point and handles routing to backend services (Glass Console, Config Service, etc.) internally.

### Step 4: Configure kind Port Mapping

For kind, you have two options:

#### Option A: Recreate Cluster with Port Mappings (Recommended)

Update your kind cluster configuration to include port mappings:

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: agentstudio
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
        protocol: TCP
      - containerPort: 443
        hostPort: 443
        protocol: TCP
```

Then recreate your cluster:

```bash
kind delete cluster --name agentstudio
kind create cluster --config kind-config.yaml
```

#### Option B: Use Port Forwarding (Quick Setup)

If your cluster is already created, use port forwarding:

```bash
# Port forward Gateway controller (run in background)
kubectl port-forward -n nginx-gateway service/nginx-gateway 80:80 443:443 &
```

**Note**: Port forwarding must remain running while you access the services.

### Step 5: Verify Setup

```bash
# Check Gateway controller
kubectl get pods -n nginx-gateway

# Check Ingress resource
kubectl get ingress -n agentstudio-services

# Check TLS secret
kubectl get secret nemo-gateway-tls -n agentstudio-services

# Test from host machine
curl -k https://agentstudio.local                  # Console GUI
curl -k https://ws-test1.agentstudio.local         # Workspace
```

### Step 6: Update Gateway Configuration

The Gateway running in Kubernetes doesn't need to handle HTTPS directly (the Ingress controller does). However, you should configure it to be aware of the subdomain routing.

**If using Helm**, update the relevant tier chart values (e.g. `deployments/helm/services/values.yaml` or `deployments/helm/console/values.yaml`):

```yaml
gateway:
  env:
    - name: WORKSPACE_SUBDOMAIN_BASE
      value: "agentstudio.local"
    - name: WORKSPACE_COOKIE_DOMAIN
      value: ".agentstudio.local"
    - name: ENABLE_SUBDOMAIN_ROUTING
      value: "true"
```

**If using kubectl**, update your deployment:

```yaml
env:
  - name: WORKSPACE_SUBDOMAIN_BASE
    value: "agentstudio.local"
  - name: WORKSPACE_COOKIE_DOMAIN
    value: ".agentstudio.local"
  - name: ENABLE_SUBDOMAIN_ROUTING
    value: "true"
```

### Troubleshooting kind Setup

**Problem**: Ingress controller not accessible from host

**Solutions**:

1. Check if Gateway controller is running: `kubectl get pods -n nginx-gateway`
2. Check service type: `kubectl get svc -n nginx-gateway nginx-gateway`
3. For NodePort, check assigned ports: `kubectl get svc -n nginx-gateway nginx-gateway -o jsonpath='{.spec.ports[*].nodePort}'`
4. Use port forwarding: `kubectl port-forward -n nginx-gateway service/nginx-gateway 80:80 443:443`
5. Check Gateway controller logs: `kubectl logs -n nginx-gateway -l app=nginx-gateway`
6. Check kind port mappings: `docker ps | grep kind`

**Problem**: Certificate errors in browser

**Solutions**:

1. Verify secret exists: `kubectl get secret nemo-gateway-tls -n agentstudio-services`
2. Check Ingress TLS configuration: `kubectl describe ingress agentstudio-ingress -n agentstudio-services`
3. Verify certificate is valid: `kubectl get secret nemo-gateway-tls -n agentstudio-services -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -text -noout`

**Problem**: DNS not resolving from within cluster

**Solutions**:

1. DNS resolution from pods uses Kubernetes DNS (CoreDNS)
2. For pod-to-pod communication, use service names (e.g., `gateway.nemo.svc.cluster.local`)
3. Host machine DNS is separate (configured via `/etc/hosts` or dnsmasq)
4. Workspace subdomains are resolved by the Ingress controller based on the `Host` header

**Problem**: Gateway service not found

**Solutions**:

1. Verify Gateway service exists: `kubectl get svc -n agentstudio-services gateway`
2. Check service port matches Ingress: `kubectl get svc -n agentstudio-services gateway -o jsonpath='{.spec.ports[0].port}'`
3. Verify Gateway pods are running: `kubectl get pods -n agentstudio-services -l app=gateway`
4. Check service selector matches pod labels: `kubectl describe svc -n agentstudio-services gateway`

**Problem**: NGINX Ingress Controller pthread_create() errors

**Symptoms**: Errors like `pthread_create() failed (11: Resource temporarily unavailable)` in Ingress controller logs

**Solutions**:

1. **Quick fix**: Run the resource limits fix script:
   ```bash
   ./scripts/fix-ingress-resource-limits.sh
   ```

2. **Gateway API configuration**: Gateway API configuration is managed via GatewayClass and Gateway resources. See Gateway API documentation for performance tuning options.

3. **Increase kind cluster resources**: If using kind, recreate the cluster with more resources:
   ```yaml
   kind: Cluster
   apiVersion: kind.x-k8s.io/v1alpha4
   nodes:
     - role: control-plane
       kubeadmConfigPatches:
         - |
           kind: InitConfiguration
           nodeRegistration:
             kubeletExtraArgs:
               node-labels: "ingress-ready=true"
       extraPortMappings:
         - containerPort: 80
           hostPort: 80
           protocol: TCP
         - containerPort: 443
           hostPort: 443
           protocol: TCP
   ```

4. **Check system limits**: On macOS, check ulimit:
   ```bash
   ulimit -u  # Check max user processes
   ulimit -n  # Check max open files
   ```

**Root Cause**: NGINX Ingress Controller tries to create too many worker threads, hitting system resource limits. Limiting `worker-processes` to 2-4 helps in resource-constrained environments like kind.

---

## Certificate Management with mkcert

The setup script uses `mkcert` for certificate management. If you need to regenerate certificates or manage them manually:

### Regenerate Certificates

```bash
cd ~/agentstudio-dev-certs
mkcert "*.agentstudio.local" "agentstudio.local" "localhost" "127.0.0.1"
```

### View mkcert CA Location

```bash
mkcert -CAROOT
```

### Uninstall mkcert CA (if needed)

```bash
mkcert -uninstall
```

### List All Certificates

```bash
ls -la ~/agentstudio-dev-certs/
```

---

## Environment-Specific Configuration

### Development Environment Variables

Create `.env.development` in your project root:

```bash
# Local Development Configuration
ENV=development
WORKSPACE_SUBDOMAIN_BASE=agentstudio.local
WORKSPACE_COOKIE_DOMAIN=.agentstudio.local
ENABLE_SUBDOMAIN_ROUTING=true

# SSL Configuration
SSL_KEY_PATH=~/agentstudio-dev-certs/wildcard-agentstudio-local-key.pem
SSL_CERT_PATH=~/agentstudio-dev-certs/wildcard-agentstudio-local-cert.pem

# Ports
PORT=8080
HTTPS_PORT=8443

# Gateway URLs
GATEWAY_URL=http://agentstudio.local:8080
GATEWAY_HTTPS_URL=https://agentstudio.local:8443

# Config Service
CONFIG_SERVICE_URL=http://agentstudio.local:3000

# Glass Console
GUI_URL=http://agentstudio.local:9000
```

---

## Quick Reference

### DNS Setup

- **Simple**: Use `/etc/hosts` (manual entries per workspace)
- **Dynamic**: Use `dnsmasq` (wildcard `*.agentstudio.local` support)

### SSL Certificates

- **Easy**: Use `mkcert` (automatic trust, recommended)
- **Wildcard**: `*.agentstudio.local` covers all `ws-<id>.agentstudio.local`

### Testing

```bash
# DNS (base domain)
dig @127.0.0.1 agentstudio.local

# DNS (workspace subdomain)
dig @127.0.0.1 ws-test1.agentstudio.local

# HTTP
curl http://ws-test1.agentstudio.local:8080

# HTTPS (no -k needed with mkcert)
curl https://ws-test1.agentstudio.local:8443
```

---

## Next Steps

After completing Phase 1 setup:

1. **Verify all components work**:
   - DNS resolution ✅
   - SSL certificates ✅
   - Gateway HTTPS ✅

2. **Proceed to Phase 2**: Gateway Changes
   - Implement hostname parsing for `ws-<id>` prefix
   - Add cookie management
   - Update workspace routing

3. **Test end-to-end**:
   - Create a test workspace
   - Access via `ws-<id>.agentstudio.local` subdomain
   - Verify all requests route correctly

---

## References

- [dnsmasq Documentation](https://thekelleys.org.uk/dnsmasq/doc.html)
- [mkcert GitHub](https://github.com/FiloSottile/mkcert)
- [OpenSSL Certificate Creation](https://www.openssl.org/docs/)
- [macOS DNS Configuration](https://support.apple.com/guide/terminal/use-dns-servers-and-search-domains-trml103/mac)

---

**Note**: This setup is for local development only. Production setup will use proper DNS providers, certificate authorities, and load balancers as described in the main design document.
