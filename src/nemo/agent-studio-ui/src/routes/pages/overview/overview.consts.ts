import { ROUTES } from "@/routes/routes.consts"
import { dataManagementPaths } from "@/routes/pages/data-management/data-management.consts"
import dataClassifierIcon from "./icons/data-classifier.svg"
import dataContainersIcon from "./icons/data-containers.svg"
import embeddingModelIcon from "./icons/embedding-model.svg"
import precisionIcon from "./icons/precision.svg"
import publishIcon from "./icons/publish.svg"
import workspaceIcon from "./icons/workspace.svg"

export type OverviewFeature = {
  icon: string
  title: string
  description: string
  buttonLabel: string
  to: string
}

export const OVERVIEW_HERO = {
  title: "Agent Studio: build AI on your data",
  tagline: "From raw data to production-ready agents in one workspace",
  description:
    "Design, test, and deploy intelligent agents that run directly on your data. Agent Studio brings projects, pipelines, models, and tooling together so teams can move from prototype to production without leaving the console.",
} as const

export const OVERVIEW_CREATE_PROJECT_TITLE = "Create your project"

export const OVERVIEW_FEATURES: OverviewFeature[] = [
  {
    icon: workspaceIcon,
    title: "Launch your first project",
    description:
      "Add a new Agent Studio project to organize data sources, datasets, knowledge bases, and agents under a single, versioned workspace.",
    buttonLabel: "Add",
    to: `/${ROUTES.PROJECTS}`,
  },
  {
    icon: dataContainersIcon,
    title: "Register your data sources",
    description:
      "Securely register databases, object stores, and APIs from across your environment, keeping credentials, access, and governance under central control.",
    buttonLabel: "Register",
    to: dataManagementPaths.dataSources,
  },
  {
    icon: embeddingModelIcon,
    title: "Create reusable datasets",
    description:
      "Add structured and unstructured datasets built from your connected sources so downstream pipelines, evaluations, and agents can rely on consistent data.",
    buttonLabel: "Add",
    to: dataManagementPaths.datasets,
  },
  {
    icon: dataClassifierIcon,
    title: "Add powerful knowledge bases",
    description:
      "Ingest documents, logs, and domain content into scalable retrieval stores that ground agent responses in the latest, most relevant information.",
    buttonLabel: "Add",
    to: `/${ROUTES.KNOWLEDGE_BASES}`,
  },
  {
    icon: publishIcon,
    title: "Build and deploy agents",
    description:
      "Deploy agents that call your models, tools, and knowledge bases to answer questions, trigger workflows, and automate day-to-day operations on top of data.",
    buttonLabel: "Add",
    to: `/${ROUTES.AGENTS}`,
  },
  {
    icon: precisionIcon,
    title: "Evaluate your agents with confidence",
    description:
      "Review agent evaluation status and runs in one place, then create new evaluations to validate quality and compare changes over time.",
    buttonLabel: "Evaluate",
    to: `/${ROUTES.EVALUATIONS}`,
  },
]
