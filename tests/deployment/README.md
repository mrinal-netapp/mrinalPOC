# Shared Allure service — Azure VM deployment

The shared [Allure](https://allurereport.org/) report service (one project per
environment) runs as Docker containers on a single small **Azure** VM, **not** on
Kubernetes. This directory is the reproducible, version-controlled definition of
that one-time setup.

The VM is reached by its **public IP** with a **self-signed** cert (no DNS name),
so clients use `ALLURE_VERIFY_TLS=0` / `curl -k`. Current deployment:

| Fact | Value |
| ---- | ----- |
| VM name | `agentstudio-allure-instance` |
| Resource group | `rg-agentstudio-allure` |
| Region / size / image | `eastus2` / `Standard_D8s_v3` / Ubuntu 24.04 |
| Public IP | static; **not committed** — read from the `ALLURE_ENDPOINT` GitHub variable or `az network public-ip show -g rg-agentstudio-allure -n agentstudio-allure-instance-pip --query ipAddress -o tsv` |
| Endpoint (`ALLURE_ENDPOINT`) | `https://<public-ip>` (GitHub variable) |
| Dashboard (UI) | `https://<public-ip>/` |
| SSH | `ssh azureuser@<public-ip>` |

- [`azure-cloud-init.yaml`](./azure-cloud-init.yaml) — first-boot config template:
  mounts the data disk, generates the self-signed cert, installs Docker, writes
  the compose + Caddyfile, starts the stack. `${ALLURE_ADMIN_PASSWORD}` /
  `${ALLURE_PUBLIC_IP}` are substituted at provision time from caller inputs
  (nothing committed).
- [`azure-provision.sh`](./azure-provision.sh) — creates the RG, a **static
  public IP**, an **NSG with source allowlists** (22 + 443), and the VM (with the
  rendered cloud-init). **No baked defaults** — every input is required and
  supplied by the caller. Idempotent / re-runnable.

## What runs on the VM

Three containers via Docker Compose (`/opt/allure-stack/docker-compose.yml`):

- `frankescobar/allure-docker-service:2.27.0` — the report **server**: hosts one
  project per environment, accumulates trend/history, exposes the upload API
  (`send-results`/`generate-report`), auth via `SECURITY_ENABLED`. Listens on
  `5050` (internal to the compose network only). History persists on the data
  disk at `/opt/allure/projects`.
- `frankescobar/allure-docker-service-ui:7.0.3` — the single-page **dashboard**
  that lists all projects and their reports. Listens on `5252` (internal). It is
  told where the API lives via `ALLURE_DOCKER_PUBLIC_API_URL=https://<public-ip>`.
- `caddy:2` — terminates TLS on `443` with a **self-signed cert** (SAN = the
  public IP) and reverse-proxies. It is a **catch-all** (`:443`, matches any
  Host, including the raw IP): `/allure-docker-service*` → `allure:5050`,
  everything else → `allure-ui:5252`.

Request flow: `https://<public-ip>/` → caddy (`:443`, TLS) → UI; and
`https://<public-ip>/allure-docker-service/...` → caddy → `allure:5050` → data on
the mounted disk.

> **Why an explicit cert, not `tls internal`?** Caddy's `tls internal` does not
> mint a leaf certificate for a bare-**IP** SNI, so the TLS handshake aborts with
> an internal-error alert. We generate a self-signed cert whose SAN includes the
> public IP (`/opt/allure/certs`) and point caddy at it.

> **Why root-host the UI?** The UI ships `<base href="/">` with relative asset
> paths, so it must be served at `/`, not a subpath like `/ui`. And set only
> `ALLURE_DOCKER_PUBLIC_API_URL` — the UI appends `/allure-docker-service`
> itself, so adding `ALLURE_DOCKER_PUBLIC_API_URL_PREFIX` doubles the path
> (`.../allure-docker-service/allure-docker-service/...` → 404s).

## Prerequisites

- `az` CLI (logged in) with rights to create the RG, public IP, NSG, and VM.
- `envsubst` (from `gettext`).
- Your Mac egress public IP (`curl -s https://api.ipify.org`) and the
  self-hosted `[self-hosted, netapp]` runner egress public IP for the NSG
  allowlist (ask the runner admin, or run `curl -s https://api.ipify.org` in any
  runner job).

## Provision (single command — supply all inputs)

Every input is required (no defaults). Run from this directory:

```bash
SUBSCRIPTION_ID=<sub-id> \
LOCATION=<region> \
ALLURE_RG=<allure-rg> \
VM_NAME=<vm-name> \
VM_SIZE=<vm-size> \
VM_IMAGE=<image> \
DATA_DISK_GB=<size> \
ADMIN_USERNAME=<admin-user> \
ALLURE_ADMIN_PASSWORD=<strong-pass> \
ALLOWED_SSH_SOURCE=<mac-egress-ip>/32 \
ALLOWED_HTTPS_SOURCES="<mac-egress-ip>/32 <runner-egress-ip>/32" \
./azure-provision.sh
```

Example values for the current deployment (substitute your own):

| Input | Example |
| ----- | ------- |
| `SUBSCRIPTION_ID` | `ae26acbb-72f9-440e-822f-b13ef3e4fec1` |
| `LOCATION` | `eastus2` |
| `ALLURE_RG` | `rg-agentstudio-allure` |
| `VM_NAME` / `VM_SIZE` / `VM_IMAGE` | `agentstudio-allure-instance` / `Standard_D8s_v3` / `Ubuntu2404` |
| `DATA_DISK_GB` / `ADMIN_USERNAME` | `128` / `azureuser` |
| `ALLOWED_SSH_SOURCE` | `167.103.88.94/32` (your Mac egress) |
| `ALLOWED_HTTPS_SOURCES` | `"167.103.88.94/32 <runner-egress-ip>/32"` |

The script fails fast listing any missing inputs, then prints the public IP and
the endpoint to configure.

## Verify

Over SSH:

```bash
ssh azureuser@<public-ip> '
  docker ps
  curl -sk https://127.0.0.1/allure-docker-service/version
  curl -sk -o /dev/null -w "unauth-write:%{http_code}\n" \
    -X POST https://127.0.0.1/allure-docker-service/projects \
    -H "Content-Type: application/json" -d "{\"id\":\"probe\"}"
'
```

Expect all three containers up, `version` `2.27.0`, and `unauth-write:401`. From
your Mac, `curl -sk https://<public-ip>/allure-docker-service/version` should
return the same JSON, and `https://<public-ip>/` should load the dashboard
(accept the self-signed warning).

## NSG allowlist (security posture)

The service is internet-facing, so keep the NSG tight: only `22` from your Mac
egress IP and `443` from the Mac + runner egress IPs. `azure-provision.sh`
creates these rules (`allow-ssh`, `allow-https`).

> **Live VM note:** the running `agentstudio-allure-instance` NSG
> (`agentstudio-allure-instance-nsg`) currently still allows `22`/`80`/`443` from
> `*` (the create-time defaults) and `80` is unused. Tightening it to the
> allowlist above (and removing the `80` rule) is a **pending follow-up** once the
> runner egress IP is confirmed.

## CI wiring

Set the repo vars/secrets the pipeline reads (see
[`../../docs/testing/integration-cicd.md`](../../docs/testing/integration-cicd.md)):

- var `ALLURE_ENDPOINT` = `https://<public-ip>` (the VM's public IP)
- var `ALLURE_VERIFY_TLS` = `0` (self-signed; no trusted cert without a DNS name)
- secret `ALLURE_USERNAME` = `admin`
- secret `ALLURE_PASSWORD` = the `ALLURE_ADMIN_PASSWORD` you passed

## Update the running stack

`azure-cloud-init.yaml` only runs on first boot. Now that the VM is SSH-able,
change the compose/Caddyfile by editing `azure-cloud-init.yaml` here (keep it the
source of truth), then apply on the box:

```bash
ssh azureuser@<public-ip>
# edit /opt/allure-stack/docker-compose.yml and /opt/allure-stack/Caddyfile to match
cd /opt/allure-stack && docker compose up -d
```

Or recreate the VM (`az vm delete` then re-run `azure-provision.sh`; history
survives only if the data disk is retained).

## Notes / hardening

- **TLS**: self-signed (`ALLURE_VERIFY_TLS=0`). A trusted (Let's Encrypt) cert is
  not available without a public DNS name; to get one, put a DNS record in front
  of the IP and switch caddy back to automatic TLS + the repo var to `1`.
- **Cleartext alternative discouraged**: publishing `allure-docker-service`
  directly on `http://<public-ip>:5050` avoids caddy but sends the Allure login
  and traffic in cleartext over the public internet. Keep the self-signed HTTPS.
- **Secret in custom-data**: the admin password is rendered into the VM's
  cloud-init (readable by holders of VM read on the box). Acceptable for an
  internal service; to remove it, pull the password from Azure Key Vault at boot
  via a managed identity instead of `SECURITY_PASS` in compose.
- **Patching / rate-limiting**: keep the OS patched; consider `fail2ban` on 22
  and rate-limiting on 443 given the public exposure.

## Decommission the old private VM

This public-IP VM replaces the earlier isolated, private-only VM. Once cutover is
confirmed, tear down the old resources:

```bash
az vm delete -g rg-agentstudio-allure -n vm-agentstudio-allure-dev-eus2-001 --yes
az network private-dns zone delete -g rg-agentstudio-allure \
  -n allure.agentstudio.dev.openeng.netapp.com --yes
# the old subnet lives in the dev VNet RG; delete only if unused:
# az network vnet subnet delete -g rg-agentstudio-dev-eus2-001 \
#   --vnet-name vnet-agentstudio-dev-eus2-001 -n snet-agentstudio-allure-dev-eus2-001
```

## Teardown (this VM)

```bash
az vm delete -g <ALLURE_RG> -n <VM_NAME> --yes
az network public-ip delete -g <ALLURE_RG> -n <VM_NAME>-pip
az network nsg delete -g <ALLURE_RG> -n <VM_NAME>-nsg
```
