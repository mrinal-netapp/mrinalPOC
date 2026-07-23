import { ROUTES } from "@/routes/routes.consts";

export const CREDENTIALS_STRINGS = {
  PAGE_TITLE: "Credentials",
  PAGE_SUBTITLE: "Manage provider credentials used by models, data sources, and other resources.",
} as const;

const CREDS_BASE = `/${ROUTES.CREDENTIALS}`;

export const credentialPaths = {
  root: CREDS_BASE,
  create: `${CREDS_BASE}/${ROUTES.CREATE}`,
  edit: (id: string): string => `${CREDS_BASE}/${id}/${ROUTES.EDIT}`,
  rotate: (id: string): string => `${CREDS_BASE}/${id}/${ROUTES.CRED_ROTATE}`,
} as const;
