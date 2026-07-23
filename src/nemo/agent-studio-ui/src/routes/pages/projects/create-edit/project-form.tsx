import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";
import { useForm } from "@tanstack/react-form";

import type { Project } from "@/api/project.types";
import {
  projectsApi,
  useCreateProjectMutation,
  useUpdateProjectMutation,
  useAddProjectMemberMutation,
  useRemoveProjectMemberMutation,
  useUpdateProjectMemberRoleMutation,
} from "@/api/project-api.slice";
import { AddEntityForm } from "@/components/common/add-entity-form/add-entity-form";
import { useAppDispatch } from "@/store/hooks";
import { Form, runFormHandleSubmit } from "@/ui-lib/base-components/form";
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { extractApiErrorMessage } from "@/utils/api-error.utils";
import { projectsPaths } from "../projects.consts";
import { ProjectAccessSection } from "./project-access-section";
import {
  EMPTY_ACCESS_MEMBER_CHANGES,
  PROJECT_ACCESS_STRINGS,
  type AccessMemberChanges,
  type PendingProjectMemberInvite,
} from "./project-access.consts";
import { ProjectDetailsSection } from "./project-details-section";
import {
  PROJECT_FORM_DEFAULT_VALUES,
  PROJECT_FORM_STRINGS,
} from "./project-form.consts";
import {
  buildProjectCreatePayload,
  buildProjectFormValuesFromProject,
  buildProjectUpdatePayload,
  validateProjectFormOnSubmit,
  waitForProjectMembershipReady,
  normalizeMemberInvites,
} from "./project-form.utils";
import "./project-form.scss";

interface ProjectFormProps {
  isEdit?: boolean;
  initialData?: Project;
}

export type ApplyMemberChangesResult = {
  failedCount: number;
  initTimedOut: boolean;
  firstErrorMessage?: string;
};

async function applyMemberChanges(
  projectId: string,
  changes: AccessMemberChanges,
  mutations: {
    addProjectMember: ReturnType<typeof useAddProjectMemberMutation>[0];
    removeProjectMember: ReturnType<typeof useRemoveProjectMemberMutation>[0];
    updateProjectMemberRole: ReturnType<typeof useUpdateProjectMemberRoleMutation>[0];
  },
): Promise<ApplyMemberChangesResult> {
  const results = await Promise.allSettled([
    ...changes.removedEmails.map((email) =>
      mutations.removeProjectMember({ projectId, body: { email } }).unwrap(),
    ),
    ...changes.roleUpdates.map(({ email, role }) =>
      mutations.updateProjectMemberRole({
        projectId,
        body: { email, role },
      }).unwrap(),
    ),
    ...changes.invites.map((invite) =>
      mutations.addProjectMember({
        projectId,
        body: { email: invite.email, role: invite.role },
      }).unwrap(),
    ),
  ]);

  const rejected = results.filter((result) => result.status === "rejected");
  const firstErrorMessage = rejected.length > 0
    ? extractApiErrorMessage(
      (rejected[0] as PromiseRejectedResult).reason,
      PROJECT_ACCESS_STRINGS.INVITE_ERROR,
    )
    : undefined;

  return {
    failedCount: rejected.length,
    initTimedOut: false,
    firstErrorMessage,
  };
}

/**
 * Delay after a successful project create before re-invalidating the
 * `ProjectList LIST` tag. The mutation's own invalidation runs
 * immediately on success — fast enough that the refetch can race the
 * server-side ProjectInitWorkflow (Bifrost VK + Lakekeeper namespace +
 * Keycloak SA / resource / role grants). This second invalidation
 * gives those activities time to settle so the list / switcher show
 * the project in a usable state.
 *
 * 3s is calibrated against measured workflow durations in dev:
 *   avg ≈ 1.76 s, worst observed ≈ 1.85 s (5-sample baseline,
 *   2026-06-30; CreateProjectServiceAccountActivity is the long pole
 *   at ~1.19 s — the rest is sub-50ms per activity).
 *
 * → 3 s ≈ 1.6× the worst case, comfortable margin without making the
 *   user wait noticeably. Bump if a slow environment regresses past
 *   this — re-measure first via the workflow-engine logs:
 *
 *     kubectl logs -n agentstudio-services deploy/workflow-engine
 *       --tail=10000 \
 *       | grep "ProjectInitWorkflow.*completed successfully"
 */
const PROJECT_CREATE_REFETCH_DELAY_MS = 3_000;

function ProjectForm({ isEdit = false, initialData }: ProjectFormProps): ReactElement {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const [createProject, { isLoading: isCreating }] = useCreateProjectMutation();
  const [updateProject, { isLoading: isUpdating }] = useUpdateProjectMutation();
  const [addProjectMember] = useAddProjectMemberMutation();
  const [removeProjectMember] = useRemoveProjectMemberMutation();
  const [updateProjectMemberRole] = useUpdateProjectMemberRoleMutation();
  const [pendingInvites, setPendingInvites] = useState<PendingProjectMemberInvite[]>([]);
  const [memberChanges, setMemberChanges] = useState<AccessMemberChanges>(EMPTY_ACCESS_MEMBER_CHANGES);
  const memberChangesRef = useRef(memberChanges);
  const pendingInvitesRef = useRef(pendingInvites);
  memberChangesRef.current = memberChanges;
  pendingInvitesRef.current = pendingInvites;
  const isSubmittingRef = useRef(false);
  const isSubmitting = isCreating || isUpdating;

  const navigateBack = useCallback(() => {
    navigate(projectsPaths.root);
  }, [navigate]);

  const defaultValues = useMemo(
    () => (initialData ? buildProjectFormValuesFromProject(initialData) : PROJECT_FORM_DEFAULT_VALUES),
    [initialData],
  );

  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: validateProjectFormOnSubmit,
    },
    onSubmit: async ({ value }) => {
      const currentMemberChanges = memberChangesRef.current;
      const currentPendingInvites = pendingInvitesRef.current;

      try {
        if (isEdit && initialData) {
          await updateProject({
            projectId: initialData.id,
            body: buildProjectUpdatePayload(value),
          }).unwrap();

          const resolvedChanges = {
            ...currentMemberChanges,
            invites: normalizeMemberInvites(currentMemberChanges.invites),
          };

          const { failedCount, firstErrorMessage } = await applyMemberChanges(
            initialData.id,
            resolvedChanges,
            {
              addProjectMember,
              removeProjectMember,
              updateProjectMemberRole,
            },
          );

          if (failedCount > 0) {
            toast.error(firstErrorMessage ?? PROJECT_ACCESS_STRINGS.MEMBERS_SAVE_ERROR);
          }

          toast.success(PROJECT_FORM_STRINGS.UPDATE_SUCCESS(value.name.trim()));
        } else {
          const createdProject = await createProject(buildProjectCreatePayload(value)).unwrap();

          if (currentPendingInvites.length > 0) {
            const initReady = await waitForProjectMembershipReady(dispatch, createdProject.id);
            if (!initReady) {
              toast.error(PROJECT_ACCESS_STRINGS.INVITE_INIT_TIMEOUT);
            } else {
              const resolvedInvites = normalizeMemberInvites(currentPendingInvites);
              const { failedCount, firstErrorMessage } = await applyMemberChanges(
                createdProject.id,
                {
                  invites: resolvedInvites,
                  removedEmails: [],
                  roleUpdates: [],
                },
                {
                  addProjectMember,
                  removeProjectMember,
                  updateProjectMemberRole,
                },
              );

              if (failedCount > 0) {
                toast.error(firstErrorMessage ?? PROJECT_ACCESS_STRINGS.INVITE_ERROR);
              }
            }
          }

          toast.success(PROJECT_FORM_STRINGS.CREATE_SUCCESS(value.name.trim()));
        }
        // Soft router-navigate for both create and edit. The list page
        // and the project switcher both subscribe to the same RTK
        // Query that `createProject` / `updateProject` /
        // `deleteProject` invalidate (`ProjectList LIST` tag); the
        // refetch fans out automatically to every subscriber, so the
        // new / changed / deleted entry shows up without a full page
        // reload.
        navigate(projectsPaths.root);
        // Create-only: the mutation's immediate invalidation races
        // post-create provisioning (Keycloak realm role + Bifrost VK +
        // S3 bucket bootstrap, all async). The first refetch can
        // therefore land before /projects sees the new entry. Schedule
        // a delayed re-invalidation so the list catches up once those
        // back-end hooks settle. See `PROJECT_CREATE_REFETCH_DELAY_MS`
        // above for the calibrated delay and the rationale — change
        // the value (and its docblock) there if a slow environment
        // needs a different number.
        if (!isEdit) {
          setTimeout(() => {
            dispatch(
              projectsApi.util.invalidateTags([{ type: "ProjectList", id: "LIST" }]),
            );
          }, PROJECT_CREATE_REFETCH_DELAY_MS);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : undefined;
        toast.error(message ?? (isEdit ? PROJECT_FORM_STRINGS.UPDATE_ERROR : PROJECT_FORM_STRINGS.CREATE_ERROR));
      } finally {
        isSubmittingRef.current = false;
      }
    },
  }) as unknown as AnyReactFormApi;

  const handleSubmit = useCallback(async () => {
    if (isSubmittingRef.current || isSubmitting) return;
    isSubmittingRef.current = true;
    await runFormHandleSubmit(form);
    isSubmittingRef.current = false;
  }, [form, isSubmitting]);

  return (
    <Form form={form} isDisabled={isSubmitting}>
      <AddEntityForm
        className="add-entity-form--project"
        open
        title={isEdit ? PROJECT_FORM_STRINGS.EDIT_TITLE : PROJECT_FORM_STRINGS.CREATE_TITLE}
        entityName="Project"
        entityDescription={PROJECT_FORM_STRINGS.CREATE_INTRO}
        addLabel={isEdit ? PROJECT_FORM_STRINGS.SAVE_LABEL : PROJECT_FORM_STRINGS.ADD_LABEL}
        cancelLabel={PROJECT_FORM_STRINGS.CANCEL_LABEL}
        onAdd={handleSubmit}
        onCancel={navigateBack}
        sections={[
          <ProjectDetailsSection key="details" form={form} />,
          <ProjectAccessSection
            key="access"
            projectId={isEdit ? initialData?.id : undefined}
            isDisabled={isSubmitting}
            pendingInvites={pendingInvites}
            onPendingInvitesChange={setPendingInvites}
            onMemberChangesChange={setMemberChanges}
          />,
        ]}
      />
    </Form>
  );
}

export { ProjectForm };
export type { ProjectFormProps };
