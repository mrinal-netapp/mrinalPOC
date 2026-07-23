#!/bin/bash
# Script to apply CoreDNS configuration in local mode (hosts mode)
# This makes /etc/hosts entries available to Kubernetes pods

set -e

echo "=== Applying CoreDNS Configuration (Local Mode) ==="
echo ""

# Step 1: (Skipped — values check not applicable for tier charts)
echo "Step 1: Skipped (tier charts manage coredns settings independently)."

# Step 2: Apply Helm chart to create the ConfigMap
echo ""
echo "Step 2: Applying services tier Helm chart to create CoreDNS ConfigMap..."
make helm-services-upgrade CLOUD=local || {
    echo "❌ Helm upgrade failed. Make sure the services tier is deployed."
    exit 1
}
echo "✅ Helm chart applied"

# Step 3: Get the CoreDNS patch from the ConfigMap
echo ""
echo "Step 3: Retrieving CoreDNS configuration patch..."
COREFILE_PATCH=$(kubectl get configmap -n kube-system -l 'agentstudio.io/coredns-config=true' -o jsonpath='{.items[0].data.Corefile\.patch}' 2>/dev/null || \
    kubectl get configmap services-coredns-config -n kube-system -o jsonpath='{.data.Corefile\.patch}' 2>/dev/null || \
    kubectl get configmap agentstudio-coredns-config -n kube-system -o jsonpath='{.data.Corefile\.patch}' 2>/dev/null || \
    kubectl get configmap nemo-coredns-config -n kube-system -o jsonpath='{.data.Corefile\.patch}' 2>/dev/null || echo "")

if [ -z "$COREFILE_PATCH" ]; then
    echo "❌ Could not find CoreDNS ConfigMap. Make sure coredns.enabled: true in values.yaml"
    exit 1
fi

echo "✅ Found CoreDNS patch:"
echo "$COREFILE_PATCH"
echo ""

# Step 4: Backup current CoreDNS ConfigMap
echo "Step 4: Backing up current CoreDNS ConfigMap..."
kubectl get configmap coredns -n kube-system -o yaml > coredns-backup-$(date +%Y%m%d-%H%M%S).yaml
echo "✅ Backup created"

# Step 5: Get current Corefile
echo ""
echo "Step 5: Getting current Corefile..."
CURRENT_COREFILE=$(kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}')

# Step 6: Check if hosts plugin already exists
if echo "$CURRENT_COREFILE" | grep -q "hosts {"; then
    echo "⚠️  Warning: hosts plugin already exists in Corefile"
    echo "   You may need to remove the old hosts block first"
    echo ""
    read -p "Continue and add new hosts block? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Step 7: Create new Corefile with hosts plugin
echo ""
echo "Step 6: Creating updated Corefile..."

# Extract the main server block (before any existing agentstudio.local block)
MAIN_BLOCK=$(echo "$CURRENT_COREFILE" | awk '/^\.:53 \{/,/^}$/ {print}' | head -n -1)

# Remove any existing agentstudio.local server block
CLEANED_COREFILE=$(echo "$CURRENT_COREFILE" | awk '/^agentstudio\.local \{/,/^}$/ {next} {print}')

# Find insertion point (after kubernetes plugin, before prometheus)
if echo "$CLEANED_COREFILE" | grep -q "prometheus"; then
    # Insert hosts plugin before prometheus
    NEW_COREFILE=$(echo "$CLEANED_COREFILE" | sed "/prometheus :9153/i\\
$COREFILE_PATCH
")
else
    # Append to main block if prometheus not found
    NEW_COREFILE=$(echo "$CLEANED_COREFILE" | sed "/kubernetes cluster.local/a\\
$COREFILE_PATCH
")
fi

# Step 8: Apply the updated ConfigMap
echo ""
echo "Step 7: Applying updated CoreDNS ConfigMap..."
kubectl patch configmap coredns -n kube-system --type merge -p "{\"data\":{\"Corefile\":$(echo "$NEW_COREFILE" | jq -Rs .)}}"

echo "✅ CoreDNS ConfigMap updated"

# Step 9: Wait for CoreDNS to reload
echo ""
echo "Step 8: Waiting for CoreDNS to reload (5 seconds)..."
sleep 5

# Step 10: Verify CoreDNS is working
echo ""
echo "Step 9: Verifying CoreDNS configuration..."
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=10 | grep -i error || echo "✅ No errors in CoreDNS logs"

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Test DNS resolution:"
echo "  kubectl run -it --rm test-dns --image=busybox --restart=Never -- nslookup us-west-2.agentstudio.local"
echo "  kubectl run -it --rm test-dns2 --image=busybox --restart=Never -- nslookup s3.us-west-2.agentstudio.local"
echo ""
