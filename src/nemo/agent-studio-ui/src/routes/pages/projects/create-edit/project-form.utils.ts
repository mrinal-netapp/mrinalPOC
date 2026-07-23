import type { Project } from "@/api/project.types";
import {
  getProjectDescription,
  PROJECT_METADATA_DESCRIPTION_KEY,
} from "@/api/project.types";
import type { CreateProjectRequest, UpdateProjectRequest } from "@/api/project.types";
import { projectsApi } from "@/api/project-api.slice";
import type { AppDispatch } from "@/store/store.types";
import { isEmailAddress } from "@/routes/pages/administration/administration-members.utils";
import type { ProjectFormValues } from "./project-form.consts";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import {
  PROJECT_ACCESS_STRINGS,
  type PendingProjectMemberInvite,
} from "./project-access.consts";

const PROJECT_INIT_MAX_ATTEMPTS = 10;
const PROJECT_INIT_RETRY_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Poll until project membership reads succeed (Keycloak resource exists after init). */
export async function waitForProjectMembershipReady(
  dispatch: AppDispatch,
  projectId: string,
  maxAttempts = PROJECT_INIT_MAX_ATTEMPTS,
  delayMs = PROJECT_INIT_RETRY_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await dispatch(
        projectsApi.endpoints.listProjectMembers.initiate(projectId, { forceRefetch: true }),
      ).unwrap();
      return true;
    } catch {
      if (attempt < maxAttempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  return false;
}

/**
 * Validate + normalize pending invite emails before they hit the write API.
 * The new membership endpoints resolve email → Keycloak userId server-side
 * (404 if unknown), so the client must reject empty / malformed entries up
 * front rather than letting them produce noisy 400s.
 */
export function normalizeMemberInvites(
  invites: PendingProjectMemberInvite[],
): PendingProjectMemberInvite[] {
  return invites.map((invite) => {
    const email = invite.email.trim().toLowerCase();
    if (!email) {
      throw new Error(PROJECT_ACCESS_STRINGS.EMAIL_REQUIRED);
    }
    if (!isEmailAddress(email)) {
      throw new Error("Enter a valid email address");
    }
    return { ...invite, email };
  });
}

export function validateProjectFormOnSubmit({ value }: { value: ProjectFormValues }) {
  if (!value.name.trim()) {
    return { fields: { name: PROJECT_FORM_STRINGS.NAME_REQUIRED } };
  }
  return undefined;
}

function buildProjectMetadata(description: string): CreateProjectRequest["metadata"] {
  const trimmed = description.trim();
  return trimmed ? { [PROJECT_METADATA_DESCRIPTION_KEY]: trimmed } : undefined;
}

export function buildProjectCreatePayload(values: ProjectFormValues): CreateProjectRequest {
  const name = values.name.trim();
  const metadata = buildProjectMetadata(values.description);

  return {
    name,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildProjectUpdatePayload(values: ProjectFormValues): UpdateProjectRequest {
  const name = values.name.trim();
  const metadata = buildProjectMetadata(values.description);

  return {
    name,
    ...(metadata ? { metadata } : { metadata: {} }),
  };
}

export function buildProjectFormValuesFromProject(project: Project): ProjectFormValues {
  return {
    name: project.name,
    description: getProjectDescription(project.metadata),
  };
}
