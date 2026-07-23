import { ROUTES } from "@/routes/routes.consts";

export const EVAL_STRINGS = {
  PAGE_TITLE: "Evaluations",
  PAGE_SUBTITLE:
    "Structured eval suites, sandboxes, and quality gates before you ship agents and pipelines.",
} as const;

const EVAL_BASE = `/${ROUTES.EVALUATIONS}`;

export const evalPaths = {
  root: EVAL_BASE,
  create: `${EVAL_BASE}/${ROUTES.CREATE}`,
  detail: (templateId: string): string => `${EVAL_BASE}/${templateId}`,
  edit: (templateId: string): string => `${EVAL_BASE}/${templateId}/${ROUTES.EDIT}`,
} as const;
