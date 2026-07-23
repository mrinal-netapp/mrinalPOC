#!/usr/bin/env python3
"""
Keycloak Realm and OIDC Client Setup Script
Uses python-keycloak SDK for robust error handling and authentication
"""

import os
import sys
import json
import subprocess
from typing import Optional, Dict, Any

try:
    from keycloak import KeycloakAdmin
    from keycloak.exceptions import KeycloakError, KeycloakGetError
except ImportError:
    print("Error: python-keycloak library not installed")
    print("Install with: pip install python-keycloak")
    sys.exit(1)


def get_env_or_default(key: str, default: str) -> str:
    """Get environment variable or return default"""
    return os.environ.get(key, default)


def create_keycloak_admin() -> KeycloakAdmin:
    """Create and configure KeycloakAdmin client"""
    keycloak_url = get_env_or_default("KEYCLOAK_URL", "http://keycloak.agentstudio-identity.svc.cluster.local:8080")
    admin_user = get_env_or_default("KEYCLOAK_ADMIN_USER", "admin")
    admin_password = get_env_or_default("KEYCLOAK_ADMIN_PASSWORD", "AgentstudioAdmin123!")
    
    # Remove trailing slash if present
    keycloak_url = keycloak_url.rstrip('/')
    
    print(f"Connecting to Keycloak at: {keycloak_url}")
    print(f"Admin user: {admin_user}")
    
    try:
        kc = KeycloakAdmin(
            server_url=keycloak_url,
            username=admin_user,
            password=admin_password,
            realm_name="master",
            client_id="admin-cli",
            verify=False,  # Disable SSL verification for internal services
            user_realm_name="master"
        )
        print("✅ Successfully connected to Keycloak")
        return kc
    except Exception as e:
        print(f"Error: Failed to connect to Keycloak: {e}")
        sys.exit(1)


def realm_exists(kc: KeycloakAdmin, realm_name: str) -> bool:
    """Check if a realm exists"""
    try:
        realm = kc.get_realm(realm_name)
        return realm is not None
    except KeycloakGetError as e:
        if e.response_code == 404:
            return False
        # Re-raise other errors
        raise
    except Exception as e:
        print(f"Error checking realm existence: {e}")
        raise


def create_realm(kc: KeycloakAdmin, realm_name: str) -> bool:
    """Create a realm if it doesn't exist"""
    print(f"Checking if realm '{realm_name}' exists...")
    
    if realm_exists(kc, realm_name):
        print(f"ℹ️  Realm '{realm_name}' already exists, skipping creation")
        return True
    
    print(f"Creating realm '{realm_name}'...")
    
    realm_config = {
        "realm": realm_name,
        "enabled": True,
        "displayName": "AgentStudio",
        "displayNameHtml": "<div class=\"kc-logo-text\"><span>AgentStudio</span></div>"
    }
    
    try:
        kc.create_realm(realm_config, skip_exists=True)
        print(f"✅ Realm '{realm_name}' created successfully")
        return True
    except KeycloakError as e:
        if "already exists" in str(e).lower() or e.response_code == 409:
            print(f"ℹ️  Realm '{realm_name}' already exists (409 Conflict)")
            return True
        print(f"Error: Failed to create realm '{realm_name}': {e}")
        if hasattr(e, 'response_code'):
            print(f"HTTP Code: {e.response_code}")
        if hasattr(e, 'response_body'):
            print(f"Response: {e.response_body}")
        return False
    except Exception as e:
        print(f"Error: Unexpected error creating realm: {e}")
        return False


def client_exists(kc: KeycloakAdmin, client_id: str) -> bool:
    """Check if a client exists (current realm must be set via change_current_realm)."""
    try:
        return kc.get_client_id(client_id) is not None
    except Exception as e:
        print(f"Error checking client existence: {e}")
        raise


def get_client_uuid(kc: KeycloakAdmin, client_id: str) -> Optional[str]:
    """Get Keycloak internal client UUID for clientId (current realm)."""
    try:
        return kc.get_client_id(client_id)
    except Exception as e:
        print(f"Error getting client UUID: {e}")
        raise


def get_client_secret(kc: KeycloakAdmin, client_uuid: str) -> Optional[str]:
    """Get client secret (client_uuid is Keycloak internal id, not clientId string)."""
    try:
        secret = kc.get_client_secrets(client_uuid)
        return secret.get('value') if secret else None
    except Exception as e:
        print(f"Error getting client secret: {e}")
        raise


def create_client(kc: KeycloakAdmin, client_config: Dict[str, Any]) -> bool:
    """Create an OIDC client in the current realm (see change_current_realm)."""
    client_id = client_config.get('clientId')
    print(f"Creating client '{client_id}'...")
    
    if client_exists(kc, client_id):
        print(f"ℹ️  Client '{client_id}' already exists, skipping creation")
        return True
    
    try:
        kc.create_client(client_config, skip_exists=True)
        print(f"✅ Client '{client_id}' created successfully")
        return True
    except KeycloakError as e:
        if "already exists" in str(e).lower() or e.response_code == 409:
            print(f"ℹ️  Client '{client_id}' already exists (409 Conflict)")
            return True
        print(f"Error: Failed to create client '{client_id}': {e}")
        if hasattr(e, 'response_code'):
            print(f"HTTP Code: {e.response_code}")
        if hasattr(e, 'response_body'):
            print(f"Response: {e.response_body}")
        return False
    except Exception as e:
        print(f"Error: Unexpected error creating client: {e}")
        return False


def wait_for_keycloak(keycloak_url: str, max_attempts: int = 60) -> bool:
    """Wait for Keycloak to be ready (polls /realms/master OpenID discovery)."""
    import time
    import requests

    url = f"{keycloak_url}/realms/master/.well-known/openid-configuration"
    print(f"Waiting for Keycloak to be ready at {url} (max ~{max_attempts * 2}s)...", flush=True)
    last_err: Optional[str] = None
    for i in range(max_attempts):
        try:
            response = requests.get(url, timeout=5, verify=False)
            if response.status_code == 200:
                print("✅ Keycloak is ready", flush=True)
                return True
            last_err = f"HTTP {response.status_code}"
        except Exception as e:
            last_err = str(e)

        if i < max_attempts - 1:
            attempt = i + 1
            if attempt == 1 or attempt % 10 == 0:
                print(
                    f"  ... attempt {attempt}/{max_attempts} (last: {last_err}); retry in 2s",
                    flush=True,
                )
            time.sleep(2)

    print(
        f"Error: Keycloak is not ready after {max_attempts} attempts (~{max_attempts * 2}s). Last error: {last_err}",
        flush=True,
    )
    print(
        "Hint: KEYCLOAK_URL must reach the Keycloak HTTP service (default name keycloak in agentstudio-identity ns) in the cluster.",
        flush=True,
    )
    print(
        "If Keycloak runs in another namespace, set keycloak.setup.keycloakNamespace or keycloak.setup.keycloakUrl in values.",
        flush=True,
    )
    return False


def update_k8s_secret(namespace: str, secret_name: str, secrets_data: Dict[str, str]) -> bool:
    """Update Kubernetes secret with client secrets"""
    try:
        print(f"Updating Kubernetes secret '{secret_name}' in namespace '{namespace}'...")
        
        # Check if kubectl is available
        try:
            subprocess.run(["kubectl", "version", "--client"], 
                          capture_output=True, check=True, timeout=5)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            print("⚠️  kubectl not available - secrets will need manual update")
            print("   Please update the 'keycloak-oidc-secrets' secret manually with the secrets shown above")
            return False
        
        # Check if secret exists
        get_result = subprocess.run(
            ["kubectl", "get", "secret", secret_name, "-n", namespace],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if get_result.returncode == 0:
            # Secret exists - update it using kubectl patch with stringData
            patch_data = {"stringData": secrets_data}
            patch_json = json.dumps(patch_data)
            
            result = subprocess.run(
                ['kubectl', 'patch', 'secret', secret_name,
                 '-n', namespace,
                 '--type', 'merge',
                 '-p', patch_json],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                print(f"✅ Successfully updated Kubernetes secret '{secret_name}'")
                return True
            else:
                print(f"⚠️  Failed to update secret: {result.stderr}")
                print("   Please update the secret manually")
                return False
        else:
            # Secret doesn't exist - create it
            print(f"Secret '{secret_name}' not found, creating it...")
            create_cmd = ["kubectl", "create", "secret", "generic", secret_name, "-n", namespace]
            for key, value in secrets_data.items():
                if value:
                    create_cmd.extend(["--from-literal", f"{key}={value}"])
            
            result = subprocess.run(
                create_cmd,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                print(f"✅ Successfully created Kubernetes secret '{secret_name}'")
                return True
            else:
                print(f"⚠️  Failed to create secret: {result.stderr}")
                print("   Please create the secret manually")
                return False
            
    except Exception as e:
        print(f"⚠️  Error updating secret: {e}")
        print("   Please update the secret manually with the secrets shown above")
        return False


def main():
    """Main setup function"""
    print("=" * 50)
    print("Keycloak Realm and OIDC Client Setup")
    print("=" * 50)
    
    # Configuration
    keycloak_url = get_env_or_default("KEYCLOAK_URL", "http://keycloak.agentstudio-identity.svc.cluster.local:8080")
    realm_name = get_env_or_default("KEYCLOAK_REALM", "agentstudio")
    domain = get_env_or_default("DOMAIN", "agentstudio.local")
    protocol = get_env_or_default("PROTOCOL", "http")
    namespace = get_env_or_default("NAMESPACE", "agentstudio")
    secret_name = get_env_or_default("SECRET_NAME", "keycloak-oidc-secrets")
    
    print(f"Keycloak URL: {keycloak_url}")
    print(f"Realm: {realm_name}")
    print(f"Domain: {domain}")
    print(f"Namespace: {namespace}")
    print(f"Secret name: {secret_name}")
    print()
    
    # Wait for Keycloak to be ready
    if not wait_for_keycloak(keycloak_url):
        sys.exit(1)
    
    # Create Keycloak admin client
    kc = create_keycloak_admin()
    
    # Create realm
    if not create_realm(kc, realm_name):
        print("Error: Failed to create realm")
        sys.exit(1)

    # python-keycloak routes client APIs via connection.realm_name — switch from master to target realm.
    try:
        kc.change_current_realm(realm_name)
        print(f"✅ Switched admin session to realm '{realm_name}'")
    except Exception as e:
        print(f"Error: Failed to switch to realm '{realm_name}': {e}")
        sys.exit(1)
    
    # Dictionary to store all secrets for K8s secret update
    k8s_secrets = {}
    
    # Create GUI client (Public Client - SPA)
    gui_client_config = {
        "clientId": "agentstudio-gui",
        "enabled": True,
        "publicClient": True,
        "standardFlowEnabled": True,
        "directAccessGrantsEnabled": False,
        "implicitFlowEnabled": False,
        "serviceAccountsEnabled": False,
        "redirectUris": [
            f"{protocol}://{domain}/console/*",
            f"{protocol}://{domain}:8443/console/*",
            "http://localhost:3000/*"
        ],
        "webOrigins": [
            f"{protocol}://{domain}",
            f"{protocol}://{domain}:8443",
            "http://localhost:3000"
        ],
        "attributes": {
            "post.logout.redirect.uris": f"{protocol}://{domain}/console,http://localhost:3000"
        }
    }
    if not create_client(kc, gui_client_config):
        print("Error: Failed to create agentstudio-gui client")
        sys.exit(1)
    k8s_secrets["gui-client-id"] = "agentstudio-gui"
    
    # Create Gateway client (Confidential)
    gateway_client_config = {
        "clientId": "agentstudio-gateway",
        "enabled": True,
        "publicClient": False,
        "standardFlowEnabled": True,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": False,
        "redirectUris": [
            f"{protocol}://{domain}/*"
        ]
    }
    if not create_client(kc, gateway_client_config):
        print("Error: Failed to create agentstudio-gateway client")
        sys.exit(1)
    k8s_secrets["gateway-client-id"] = "agentstudio-gateway"
    
    # Get gateway client secret
    gateway_uuid = get_client_uuid(kc, "agentstudio-gateway")
    if gateway_uuid:
        gateway_secret = get_client_secret(kc, gateway_uuid)
        if gateway_secret:
            print(f"Gateway client secret: {gateway_secret}")
            k8s_secrets["gateway-client-secret"] = gateway_secret
    
    # Create Lakekeeper client (Confidential, machine user)
    lakekeeper_client_config = {
        "clientId": "agentstudio-lakekeeper",
        "enabled": True,
        "publicClient": False,
        "standardFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": True,
        "redirectUris": []
    }
    if not create_client(kc, lakekeeper_client_config):
        print("Error: Failed to create agentstudio-lakekeeper client")
        sys.exit(1)
    k8s_secrets["lakekeeper-client-id"] = "agentstudio-lakekeeper"
    
    # Get lakekeeper client secret
    lakekeeper_uuid = get_client_uuid(kc, "agentstudio-lakekeeper")
    if lakekeeper_uuid:
        lakekeeper_secret = get_client_secret(kc, lakekeeper_uuid)
        if lakekeeper_secret:
            print(f"Lakekeeper client secret: {lakekeeper_secret}")
            k8s_secrets["lakekeeper-client-secret"] = lakekeeper_secret
    
    # Create Lakekeeper UI client (Public Client - SPA)
    lakekeeper_ui_client_config = {
        "clientId": "agentstudio-lakekeeper-ui",
        "enabled": True,
        "publicClient": True,
        "standardFlowEnabled": True,
        "directAccessGrantsEnabled": False,
        "implicitFlowEnabled": False,
        "serviceAccountsEnabled": False,
        "redirectUris": [
            f"{protocol}://{domain}/*"
        ],
        "webOrigins": [
            f"{protocol}://{domain}"
        ]
    }
    if not create_client(kc, lakekeeper_ui_client_config):
        print("Error: Failed to create agentstudio-lakekeeper-ui client")
        sys.exit(1)
    k8s_secrets["lakekeeper-ui-client-id"] = "agentstudio-lakekeeper-ui"
    
    # Create Swagger UI client (Public Client - for API testing from Swagger UI)
    swagger_client_config = {
        "clientId": "agentstudio-swagger",
        "enabled": True,
        "publicClient": True,
        "standardFlowEnabled": True,
        "directAccessGrantsEnabled": False,
        "implicitFlowEnabled": False,
        "serviceAccountsEnabled": False,
        "redirectUris": [
            f"{protocol}://{domain}/api-docs/*",
            f"{protocol}://{domain}:8443/api-docs/*",
            f"https://{domain}/api-docs/*",
            f"https://{domain}:8443/api-docs/*",
            "http://localhost:8080/api-docs/*"
        ],
        "webOrigins": [
            f"{protocol}://{domain}",
            f"{protocol}://{domain}:8443",
            f"https://{domain}",
            f"https://{domain}:8443",
            "http://localhost:8080"
        ],
        "attributes": {
            "pkce.code.challenge.method": "S256"
        }
    }
    if not create_client(kc, swagger_client_config):
        print("Error: Failed to create agentstudio-swagger client")
        sys.exit(1)
    k8s_secrets["swagger-client-id"] = "agentstudio-swagger"
    
    # Create service account clients
    services = [
        "workflow-engine",
        "analytics-engine",
        "config-service",
        "agent-service",
        "connector-worker",
    ]
    for service in services:
        client_id = f"agentstudio-{service}"
        service_client_config = {
            "clientId": client_id,
            "enabled": True,
            "publicClient": False,
            "standardFlowEnabled": False,
            "directAccessGrantsEnabled": False,
            "serviceAccountsEnabled": True,
            "redirectUris": []
        }
        if not create_client(kc, service_client_config):
            print(f"Error: Failed to create {client_id} client")
            sys.exit(1)
        
        # Store client ID
        k8s_secrets[f"{service}-client-id"] = client_id
        
        # Get client secret
        client_uuid = get_client_uuid(kc, client_id)
        if client_uuid:
            client_secret = get_client_secret(kc, client_uuid)
            if client_secret:
                print(f"{service} client secret: {client_secret}")
                k8s_secrets[f"{service}-client-secret"] = client_secret
    
    # Update Kubernetes secret with all collected secrets
    print()
    print("=" * 50)
    if update_k8s_secret(namespace, secret_name, k8s_secrets):
        print("✅ Kubernetes secret updated successfully!")
        print(f"   Secret: {secret_name} in namespace: {namespace}")
        print("   Services will pick up the new secrets on next restart")
    else:
        print("⚠️  Warning: Failed to update Kubernetes secret")
        print("    Services may need manual secret configuration")
        print(f"    You can run: ./scripts/update-config-service-keycloak-secret.sh")
    
    print()
    print("=" * 50)
    print("✅ Keycloak setup completed successfully!")
    print("=" * 50)
    print()
    print(f"Realm: {realm_name}")
    print("Clients created:")
    print("  - agentstudio-gui (Public)")
    print("  - agentstudio-gateway (Confidential)")
    print("  - agentstudio-lakekeeper (Confidential)")
    print("  - agentstudio-lakekeeper-ui (Public)")
    print("  - agentstudio-swagger (Public - for Swagger UI API testing)")
    print("  - agentstudio-workflow-engine (Service Account)")
    print("  - agentstudio-analytics-engine (Service Account)")
    print("  - agentstudio-config-service (Service Account)")
    print("  - agentstudio-agent-service (Service Account)")
    print("  - agentstudio-connector-worker (Service Account)")
    print()
    
    # Reminder to restart services
    if k8s_secrets:
        print("Note: To apply the new secrets, restart the affected services:")
        print("  kubectl rollout restart deployment/config-service -n agentstudio")
        print("  kubectl rollout restart deployment/workflow-engine -n agentstudio")
        print("  kubectl rollout restart deployment/analytics-engine -n agentstudio")
        print("  kubectl rollout restart deployment/connector-worker -n agentstudio")


if __name__ == "__main__":
    main()
