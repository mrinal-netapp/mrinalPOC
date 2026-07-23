# How to Apply CoreDNS Configuration in Local Mode

This guide shows you how to apply CoreDNS configuration in local mode (hosts mode) to make your `/etc/hosts` entries available to Kubernetes pods.

## Prerequisites

- AgentStudio Helm chart deployed
- Access to `kube-system` namespace
- `kubectl` configured

## Step-by-Step Instructions

### Step 1: Enable CoreDNS in values.yaml

Edit the relevant tier chart values (e.g. `deployments/helm/services/values.yaml`):

```yaml
coredns:
  enabled: true  # Change from false to true
  mode: "hosts"  # Use "hosts" for local mode
  domain: "agentstudio.local"
  
  hosts:
    entries:
      - ip: "127.0.0.1"
        hostnames:
          - "agentstudio.local"
          - "us-west-2.agentstudio.local"
          - "s3.us-west-2.agentstudio.local"
          # Add more entries as needed
```

### Step 2: Apply Helm Chart

```bash
# From the project root
make helm-services-upgrade-local
```

This creates a ConfigMap `nemo-coredns-config` in `kube-system` namespace with the CoreDNS patch.

### Step 3: Get the CoreDNS Patch

```bash
kubectl get configmap nemo-coredns-config -n kube-system -o jsonpath='{.data.Corefile\.patch}'
```

You should see something like:
```
hosts {
   127.0.0.1 agentstudio.local us-west-2.agentstudio.local s3.us-west-2.agentstudio.local
   fallthrough
}
```

### Step 4: Backup Current CoreDNS ConfigMap

```bash
kubectl get configmap coredns -n kube-system -o yaml > coredns-backup.yaml
```

### Step 5: Edit CoreDNS ConfigMap

```bash
kubectl edit configmap coredns -n kube-system
```

In the editor, find the `Corefile` section and add the hosts plugin block **AFTER the `kubernetes` plugin and BEFORE `prometheus`**.

**Example structure:**

```yaml
.:53 {
    errors
    health {
       lameduck 5s
    }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {
       pods insecure
       fallthrough in-addr.arpa ip6.arpa
       ttl 30
    }
    # ADD HOSTS PLUGIN HERE
    hosts {
       127.0.0.1 agentstudio.local
       127.0.0.1 us-west-2.agentstudio.local
       127.0.0.1 s3.us-west-2.agentstudio.local
       fallthrough
    }
    prometheus :9153
    forward . /etc/resolv.conf {
       max_concurrent 1000
    }
    cache 30 {
       disable success cluster.local
       disable denial cluster.local
    }
    loop
    reload
    loadbalance
}
```

**Important**: 
- The `hosts` block must be inside the main `.:53` server block
- Place it after `kubernetes` and before `prometheus`
- Include `fallthrough` at the end of the hosts block

### Step 6: Save and Apply

Save the file. CoreDNS will automatically reload when the ConfigMap changes (usually within 5-10 seconds).

### Step 7: Verify Configuration

Check CoreDNS logs for errors:
```bash
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=20
```

Test DNS resolution from a pod:
```bash
# Test regular subdomain
kubectl run -it --rm test-dns --image=busybox --restart=Never -- nslookup us-west-2.agentstudio.local

# Test s3 subdomain
kubectl run -it --rm test-dns2 --image=busybox --restart=Never -- nslookup s3.us-west-2.agentstudio.local
```

Both should resolve to `127.0.0.1`.

## Alternative: Using the Script

You can also use the automated script:

```bash
./scripts/apply-coredns-local.sh
```

The script will:
1. Check configuration
2. Apply Helm chart
3. Get the CoreDNS patch
4. Backup current ConfigMap
5. Merge the patch into CoreDNS ConfigMap
6. Verify the configuration

## Troubleshooting

### CoreDNS Not Reloading

If CoreDNS doesn't reload automatically:
```bash
# Restart CoreDNS pods
kubectl rollout restart deployment coredns -n kube-system
```

### DNS Still Not Resolving

1. **Check hosts block is in correct location**:
   ```bash
   kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}' | grep -A 5 "hosts"
   ```

2. **Verify IP addresses**:
   - For local services, use `127.0.0.1`
   - For Kubernetes services, use ClusterIP or LoadBalancer IP

3. **Check CoreDNS logs**:
   ```bash
   kubectl logs -n kube-system -l k8s-app=kube-dns --tail=50
   ```

### Adding More Entries

To add more DNS entries, edit `values.yaml`:

```yaml
coredns:
  hosts:
    entries:
      - ip: "127.0.0.1"
        hostnames:
          - "agentstudio.local"
          - "us-west-2.agentstudio.local"
          - "s3.us-west-2.agentstudio.local"
          - "us-east-1.agentstudio.local"  # Add new entries here
          - "s3.us-east-1.agentstudio.local"
```

Then re-apply the Helm chart and update the CoreDNS ConfigMap.

## Notes

- The hosts plugin works like `/etc/hosts` but for all pods
- Changes take effect immediately (CoreDNS auto-reloads)
- You can have multiple IP entries with different hostnames
- The `fallthrough` directive allows other plugins to handle queries if hosts doesn't match
