# cert-manager Private TLS Runbook

This runbook describes the scalable TLS model for private AgentStudio clusters:

- cert-manager manages certificate issuance and renewal.
- Gateway TLS uses a cert-manager-managed Secret (`nemo-gateway-tls` by default).
- Certificates cover all effective Gateway HTTPRoute hostnames.
- Browser trust comes from your enterprise CA trust distribution (MDM/GPO).

## 1) Recommended Issuer Backend (Private Environments)

For private domains, use an enterprise PKI-backed issuer and do **not** use mkcert for shared environments.

Recommended:

- Pre-provision a `ClusterIssuer` integrated with corporate CA.
- Configure Helm to reference that `ClusterIssuer` via `certManager.issuerRef`.

The chart also supports optional in-chart issuer creation for simple setups:

- `certManager.issuer.create=true`
- `certManager.issuer.type=ca` with a CA signing secret
- or `certManager.issuer.type=selfSigned` (non-production only)

## 2) Endpoint and SAN Behavior

The endpoint is set at deploy time (for example `ENDPOINT=mycorp.internal make deploy-all-tiers-aks`).

Helm passes this as:

- `endpoint`
- `global.endpoint`

Effective certificate SANs are generated from the same hostname set used by `HTTPRoute`:

- If `httproute.hosts` is set, SANs use that list directly.
- Otherwise SANs use defaults:
  - `<endpoint>`
  - `*.ws.<endpoint>`
  - `ws.<endpoint>`
  - `s3.<endpoint>`
  - `*.s3.<endpoint>`
  - `auth.<endpoint>`
  - `catalog.<endpoint>`
  - `workflows.<endpoint>`

## 3) Enable cert-manager Mode

Example Helm overrides:

```bash
--set certManager.enabled=true \
--set certManager.issuerRef.name=corp-private-ca \
--set certManager.issuerRef.kind=ClusterIssuer \
--set certManager.certificate.secretName=nemo-gateway-tls
```

If cert-manager CRDs are present, `scripts/prepare-nemo-gateway.sh` now auto-skips legacy manual TLS secret generation unless `FORCE_LEGACY_TLS_PREP=1` is set.

## 4) Validation Checklist

1. Verify cert-manager CRDs/controllers:
   - `kubectl get crd certificates.cert-manager.io`
   - `kubectl get pods -n cert-manager`
2. Verify Certificate readiness:
   - `kubectl get certificate -n agentstudio-services`
   - `kubectl describe certificate nemo-gateway-certificate -n agentstudio-services`
3. Verify Secret exists and is refreshed:
   - `kubectl get secret nemo-gateway-tls -n agentstudio-services`
4. Verify SANs:
   - `kubectl get secret nemo-gateway-tls -n agentstudio-services -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -text`
5. Verify Gateway listener cert reference and HTTPS readiness:
   - `kubectl get gateway -n agentstudio-services`
   - `kubectl describe gateway <gateway-name> -n agentstudio-services`
6. Browser validation:
   - Open `https://auth.<endpoint>:8443` and `https://<workspace>.ws.<endpoint>:8443`
   - Confirm no trust warning for managed endpoints.

## 5) Renewal and Operations

- cert-manager automatically renews certificates before expiry (`renewBefore`).
- Monitor:
  - cert-manager events (`kubectl get events -n cert-manager --sort-by=.lastTimestamp`)
  - certificate status conditions (`Ready`, `Issuing`)
- Recommended alerts:
  - Certificate not `Ready=True`
  - Expiry within X days without successful renewal

## 6) Troubleshooting

- **Certificate pending**: check issuer reference name/kind/group and issuer status.
- **Browser trust warning**: endpoint devices do not trust CA root/intermediate yet.
- **Hostname mismatch**: compare `HTTPRoute.spec.hostnames` and Certificate SANs.
- **No secret updates**: ensure cert-manager has RBAC and the Certificate exists in the same namespace as the target Secret.
