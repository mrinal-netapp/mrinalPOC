/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string | undefined;
  readonly VITE_UTILITIES_API_BASE_URL: string | undefined;
  readonly VITE_AGENT_API_BASE_URL: string | undefined;
  readonly VITE_AGENT_RUNTIME_API_BASE_URL: string | undefined;
  readonly VITE_AGENTS_CONFIG_API_BASE_URL: string | undefined;
  readonly VITE_KB_RETRIEVAL_API_BASE_URL: string | undefined;
  readonly VITE_DEV_PROXY_TARGET: string | undefined;
  readonly VITE_DEV_PROXY_GATEWAY: string | undefined;
  readonly VITE_ACCESS_TOKEN: string | undefined;
  readonly VITE_MODEL_SERVICE_BASE_URL: string | undefined;
  readonly VITE_DEV_MODEL_SERVICE_PROXY_TARGET: string | undefined;
  readonly VITE_AUTH_ENABLED: string | undefined;
  readonly VITE_KEYCLOAK_ISSUER: string | undefined;
  readonly VITE_KEYCLOAK_CLIENT_ID: string | undefined;
  readonly VITE_KEYCLOAK_IDP_SIGNOUT: string | undefined;
  readonly VITE_KEYCLOAK_POST_LOGOUT_REDIRECT_URI: string | undefined;
  readonly VITE_BASE_PATH: string | undefined;
  readonly VITE_USER_ID: string | undefined;
  readonly VITE_ORG_ID: string | undefined;
  readonly VITE_CHATBOT_URL: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
