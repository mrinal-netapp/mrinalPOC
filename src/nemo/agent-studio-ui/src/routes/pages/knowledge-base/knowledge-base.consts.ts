import { ROUTES } from "@/routes/routes.consts";

export const KB_STRINGS = {
  PAGE_TITLE: "Knowledge Bases",
  PAGE_SUBTITLE:
    "A knowledge base is a collection of documents within a dataset. Documents in this collection are used to provide accurate, grounded answers and support.",
} as const;

const KB_BASE = `/${ROUTES.KNOWLEDGE_BASES}`;

export const kbPaths = {
  root: KB_BASE,
  create: `${KB_BASE}/${ROUTES.CREATE}`,
  detail: (kbId: string): string => `${KB_BASE}/${kbId}`,
  edit: (kbId: string): string => `${KB_BASE}/${kbId}/${ROUTES.EDIT}`,
} as const;
