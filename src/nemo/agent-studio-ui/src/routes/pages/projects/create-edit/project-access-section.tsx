import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { IconInfoCircle, IconTrash } from "@tabler/icons-react";

import type { ProjectMember, ProjectMemberRole } from "@/api/project.types";
// `email` is the canonical identifier for membership writes against the new
// workflow-engine API (POST/DELETE/PUT all carry email in the body and resolve
// to a Keycloak userId server-side). The form still keeps `userId` on existing
// rows for display, but never sends it.
import { formatProjectMemberCount } from "@/api/project.types";
import { useListProjectMembersQuery } from "@/api/project-api.slice";
import { Button } from "@/ui-lib/base-components/button/button";
import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Tooltip } from "@/ui-lib/base-components/tooltip/tooltip";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ProjectFormSection } from "./project-form-section";
import { PROJECT_FORM_STRINGS } from "./project-form.consts";
import {
  PROJECT_ACCESS_STRINGS,
  PROJECT_MEMBER_ROLE_OPTIONS,
  computeAccessMemberChanges,
  createAccessUserRow,
  toApiMemberRole,
  type AccessInviteMode,
  type AccessMemberChanges,
  type AccessUserRole,
  type AccessUserRow,
  type PendingProjectMemberInvite,
} from "./project-access.consts";
import "./project-access-section.scss";

interface ProjectAccessSectionProps {
  projectId?: string;
  isDisabled?: boolean;
  pendingInvites?: PendingProjectMemberInvite[];
  onPendingInvitesChange?: (invites: PendingProjectMemberInvite[]) => void;
  onMemberChangesChange?: (changes: AccessMemberChanges) => void;
}

type EditAccessSeed = {
  localRows: AccessUserRow[];
  initialEmails: string[];
  initialRolesByEmail: Record<string, ProjectMemberRole>;
};

function createLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `row-${Math.random().toString(36).slice(2)}`;
}

function buildEditAccessSeed(
  members: ProjectMember[],
  isMembersError: boolean,
): EditAccessSeed {
  if (isMembersError || members.length === 0) {
    return {
      localRows: [createAccessUserRow()],
      initialEmails: [],
      initialRolesByEmail: {},
    };
  }

  // Members without an email can't be diffed/edited against the new write API.
  // Keep them visible in the row list but exclude them from the initial-email
  // set so they aren't reported as "removed" when the user saves.
  const membersWithEmail = members.filter(
    (m): m is ProjectMember & { email: string } => Boolean(m.email),
  );

  return {
    localRows: members.map((member) => ({
      localId: member.userId,
      userId: member.userId,
      email: member.email ?? "",
      role: member.role,
    })),
    initialEmails: membersWithEmail.map((member) => member.email.trim().toLowerCase()),
    initialRolesByEmail: Object.fromEntries(
      membersWithEmail.map((member) => [member.email.trim().toLowerCase(), member.role]),
    ),
  };
}

function buildEditAccessSeedKey(
  projectId: string,
  isMembersError: boolean,
  members: ProjectMember[],
): string {
  if (isMembersError) {
    return `${projectId}:error`;
  }

  return `${projectId}:${members.map((member) => `${member.email ?? member.userId}:${member.role}`).join("|")}`;
}

type AccessUsersTableProps = {
  localRows: AccessUserRow[];
  isDisabled: boolean;
  onAddUserRow: () => void;
  onRemoveRow: (localId: string) => void;
  onRoleChange: (localId: string, role: AccessUserRole) => void;
  onEmailChange: (localId: string, email: string) => void;
};

function AccessUsersTable({
  localRows,
  isDisabled,
  onAddUserRow,
  onRemoveRow,
  onRoleChange,
  onEmailChange,
}: AccessUsersTableProps): ReactElement {
  const renderUserRow = (row: AccessUserRow, index: number): ReactElement => (
    <li key={row.localId} className="project-access-section__user-row">
      <div className="project-access-section__role-field">
        <SelectDropdown
          size="fill"
          items={[...PROJECT_MEMBER_ROLE_OPTIONS]}
          value={row.role}
          onValueChange={(value) => onRoleChange(row.localId, String(value) as AccessUserRole)}
          options={{ isClearable: false }}
          disabled={isDisabled}
        />
      </div>

      <div className="project-access-section__email-field">
        <input
          type="text"
          className="project-access-section__email-input"
          value={row.email}
          placeholder={PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_PLACEHOLDER}
          aria-label={`${PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL} ${index + 1}`}
          disabled={isDisabled}
          onChange={(event) => onEmailChange(row.localId, event.target.value)}
        />
      </div>

      <button
        type="button"
        className="project-access-section__remove-button"
        aria-label={PROJECT_ACCESS_STRINGS.REMOVE_USER_ARIA_LABEL}
        disabled={isDisabled}
        onClick={() => onRemoveRow(row.localId)}
      >
        <IconTrash size={18} aria-hidden />
      </button>
    </li>
  );

  return (
    <div className="project-access-section__users">
      <Typography Component="h3" fontSize="fs14" boldness="semibold">
        {PROJECT_ACCESS_STRINGS.USERS_HEADING(localRows.length)}
      </Typography>

      <div className="project-access-section__users-header">
        <Typography Component="span" fontSize="fs14" boldness="semibold" className="project-access-section__column-label">
          {PROJECT_ACCESS_STRINGS.ROLE_LABEL}
        </Typography>
        <Typography Component="span" fontSize="fs14" boldness="semibold" className="project-access-section__column-label">
          {PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_LABEL}
          <Tooltip content={PROJECT_ACCESS_STRINGS.EMAIL_ADDRESS_TOOLTIP} side="top" />
        </Typography>
        <span className="project-access-section__header-spacer" aria-hidden />
      </div>

      <ul className="project-access-section__user-list">
        {localRows.map((row, index) => renderUserRow(row, index))}
      </ul>

      <Button
        variant="outline"
        size="medium"
        label={PROJECT_ACCESS_STRINGS.ADD_USER_LABEL}
        isDisabled={isDisabled}
        onClick={onAddUserRow}
      />
    </div>
  );
}

type ProjectAccessEditRowsProps = {
  seed: EditAccessSeed;
  isDisabled: boolean;
  onMemberChangesChange?: (changes: AccessMemberChanges) => void;
  onFilledCountChange: (count: number) => void;
};

function ProjectAccessEditRows({
  seed,
  isDisabled,
  onMemberChangesChange,
  onFilledCountChange,
}: ProjectAccessEditRowsProps): ReactElement {
  const [localRows, setLocalRows] = useState(seed.localRows);
  const { initialEmails, initialRolesByEmail } = seed;

  const filledCount = useMemo(
    () => localRows.filter((row) => row.email.trim()).length,
    [localRows],
  );

  useEffect(() => {
    onFilledCountChange(filledCount);
  }, [filledCount, onFilledCountChange]);

  useEffect(() => {
    onMemberChangesChange?.(
      computeAccessMemberChanges(initialEmails, initialRolesByEmail, localRows),
    );
  }, [initialEmails, initialRolesByEmail, localRows, onMemberChangesChange]);

  const handleAddUserRow = useCallback(() => {
    setLocalRows((current) => [...current, createAccessUserRow({ localId: createLocalId() })]);
  }, []);

  const handleRemoveRow = useCallback((localId: string) => {
    setLocalRows((current) => {
      if (current.length <= 1) {
        return [createAccessUserRow({ localId: createLocalId() })];
      }
      return current.filter((row) => row.localId !== localId);
    });
  }, []);

  const handleRoleChange = useCallback((localId: string, role: AccessUserRole) => {
    setLocalRows((current) => current.map((row) => (
      row.localId === localId ? { ...row, role } : row
    )));
  }, []);

  const handleEmailChange = useCallback((localId: string, email: string) => {
    setLocalRows((current) => current.map((row) => (
      row.localId === localId ? { ...row, email } : row
    )));
  }, []);

  return (
    <>
      <Typography Component="p" fontSize="fs14" className="project-access-section__permissions-hint">
        {PROJECT_ACCESS_STRINGS.ROLE_PERMISSIONS_HINT}
      </Typography>
      <AccessUsersTable
        localRows={localRows}
        isDisabled={isDisabled}
        onAddUserRow={handleAddUserRow}
        onRemoveRow={handleRemoveRow}
        onRoleChange={handleRoleChange}
        onEmailChange={handleEmailChange}
      />
    </>
  );
}

function ProjectAccessSection({
  projectId,
  isDisabled = false,
  onPendingInvitesChange,
  onMemberChangesChange,
}: ProjectAccessSectionProps): ReactElement {
  const isEditMode = Boolean(projectId);
  const [inviteMode, setInviteMode] = useState<AccessInviteMode>("now");
  const [localRows, setLocalRows] = useState<AccessUserRow[]>([createAccessUserRow()]);
  const [editCountsByProject, setEditCountsByProject] = useState<Record<string, number>>({});

  const {
    data: membersData,
    isLoading: isLoadingMembers,
    isError: isMembersError,
  } = useListProjectMembersQuery(projectId ?? "", { skip: !projectId });

  const members = useMemo(
    () => membersData?.members ?? [],
    [membersData?.members],
  );
  const showInviteUsersPanel = isEditMode || inviteMode === "now";
  const editAccessSeed = useMemo(
    () => buildEditAccessSeed(members, isMembersError),
    [isMembersError, members],
  );
  const editAccessSeedKey = projectId
    ? buildEditAccessSeedKey(projectId, isMembersError, members)
    : null;
  const editFilledCount = projectId ? editCountsByProject[projectId] ?? null : null;

  const sectionStatus = useMemo(() => {
    if (isEditMode) {
      if (isLoadingMembers) {
        return PROJECT_ACCESS_STRINGS.LOADING_MEMBERS;
      }

      if (editFilledCount !== null) {
        return formatProjectMemberCount(editFilledCount);
      }

      return undefined;
    }

    if (inviteMode === "later") {
      return PROJECT_ACCESS_STRINGS.ACTION_NEEDED;
    }

    return undefined;
  }, [editFilledCount, inviteMode, isEditMode, isLoadingMembers]);

  useEffect(() => {
    if (isEditMode) {
      return;
    }

    if (inviteMode === "later") {
      onPendingInvitesChange?.([]);
      return;
    }

    onPendingInvitesChange?.(
      localRows
        .filter((row) => row.email.trim())
        .map((row) => ({
          email: row.email.trim(),
          role: toApiMemberRole(row.role),
        })),
    );
  }, [inviteMode, isEditMode, localRows, onPendingInvitesChange]);

  const handleInviteModeChange = useCallback((value: string | string[]) => {
    setInviteMode((Array.isArray(value) ? value[0] : value) as AccessInviteMode);
  }, []);

  const handleAddUserRow = useCallback(() => {
    setLocalRows((current) => [...current, createAccessUserRow({ localId: createLocalId() })]);
  }, []);

  const handleRemoveRow = useCallback((localId: string) => {
    setLocalRows((current) => {
      if (current.length <= 1) {
        return [createAccessUserRow({ localId: createLocalId() })];
      }
      return current.filter((row) => row.localId !== localId);
    });
  }, []);

  const handleRoleChange = useCallback((localId: string, role: AccessUserRole) => {
    setLocalRows((current) => current.map((row) => (
      row.localId === localId ? { ...row, role } : row
    )));
  }, []);

  const handleEmailChange = useCallback((localId: string, email: string) => {
    setLocalRows((current) => current.map((row) => (
      row.localId === localId ? { ...row, email } : row
    )));
  }, []);

  const handleEditFilledCountChange = useCallback((count: number) => {
    if (!projectId) {
      return;
    }
    setEditCountsByProject((current) => ({ ...current, [projectId]: count }));
  }, [projectId]);

  return (
    <ProjectFormSection
      title={PROJECT_FORM_STRINGS.ACCESS_SECTION_TITLE}
      status={sectionStatus}
      defaultExpanded={isEditMode}
    >
      {!isEditMode && (
        <>
          <Typography Component="p" fontSize="fs14" className="project-access-section__intro">
            {PROJECT_ACCESS_STRINGS.INTRO}
          </Typography>

          <RadioGroup
            value={inviteMode}
            onValueChange={handleInviteModeChange}
            className="project-access-section__radio-group"
            ariaLabel="Invite users options"
          >
            <SelectorWrapper
              selectorType="radioButton"
              label={PROJECT_ACCESS_STRINGS.INVITE_NOW_LABEL}
              labelBoldness="semibold"
              description={PROJECT_ACCESS_STRINGS.INVITE_NOW_DESCRIPTION}
              selectorProps={{ value: "now" }}
              isDisabled={isDisabled}
            />
            <SelectorWrapper
              selectorType="radioButton"
              label={PROJECT_ACCESS_STRINGS.INVITE_LATER_LABEL}
              labelBoldness="semibold"
              description={PROJECT_ACCESS_STRINGS.INVITE_LATER_DESCRIPTION}
              selectorProps={{ value: "later" }}
              isDisabled={isDisabled}
            />
          </RadioGroup>
        </>
      )}

      {!isEditMode && inviteMode === "later" && (
        <Typography Component="p" fontSize="fs14" className="project-access-section__later-info">
          <IconInfoCircle size={16} aria-hidden className="project-access-section__later-info-icon" />
          {PROJECT_ACCESS_STRINGS.INVITE_LATER_INFO}
        </Typography>
      )}

      {isEditMode && isLoadingMembers && (
        <div className="project-access-section__loading">
          <Spinner size="fitContent" />
        </div>
      )}

      {isEditMode && isMembersError && !isLoadingMembers && (
        <Typography Component="p" fontSize="fs14" color="var(--notification-error)" className="project-access-section__inline-error">
          {PROJECT_ACCESS_STRINGS.LOAD_MEMBERS_ERROR}
        </Typography>
      )}

      {showInviteUsersPanel && !isEditMode && (
        <>
          <Typography Component="p" fontSize="fs14" className="project-access-section__permissions-hint">
            {PROJECT_ACCESS_STRINGS.ROLE_PERMISSIONS_HINT}
          </Typography>
          <AccessUsersTable
            localRows={localRows}
            isDisabled={isDisabled}
            onAddUserRow={handleAddUserRow}
            onRemoveRow={handleRemoveRow}
            onRoleChange={handleRoleChange}
            onEmailChange={handleEmailChange}
          />
        </>
      )}

      {isEditMode && !isLoadingMembers && editAccessSeedKey !== null && (
        <ProjectAccessEditRows
          key={editAccessSeedKey}
          seed={editAccessSeed}
          isDisabled={isDisabled}
          onMemberChangesChange={onMemberChangesChange}
          onFilledCountChange={handleEditFilledCountChange}
        />
      )}
    </ProjectFormSection>
  );
}

export { ProjectAccessSection };
export type { ProjectAccessSectionProps };
