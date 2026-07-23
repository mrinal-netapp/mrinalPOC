import type { AccessUserRole } from "@/routes/pages/projects/create-edit/project-access.consts";

export const ADMINISTRATION_MEMBERS_STRINGS = {
  SUMMARY_TOTAL: "Total members",
  SUMMARY_ADMINS: "Admins",
  SUMMARY_MEMBERS: "Members",
  SUMMARY_VIEWERS: "Viewers",
  TABLE_TITLE: (count: number) => `Members (${count})`,
  ADD_MEMBER_LABEL: "Add member",
  SEARCH_PLACEHOLDER: "Search members...",
  LOAD_ERROR: "Failed to load project members. Please try again.",
  STUB_PREVIEW_BANNER:
    "Showing sample member data because the members API returned 401. Changes are local only and will reset on refresh.",
  EMPTY_STATE: "No members yet. Add a member to grant access to this project.",
  DELETE_DIALOG_TITLE: "Delete user",
  DELETE_CONFIRM_LABEL: "Delete",
  DELETE_CANCEL_LABEL: "Cancel",
  DELETE_DESCRIPTION_PREFIX:
    "Are you sure that you want to delete the user",
  DELETE_DESCRIPTION_SUFFIX:
    "? This will remove the user and disconnect all of their roles and associations with this project.",
  DELETE_UNDO_WARNING: "You cannot undo this action.",
  DELETE_SUCCESS: (name: string) => `User "${name}" removed successfully.`,
  DELETE_ERROR: "Failed to remove user. Please try again.",
  ADD_FORM_TITLE: "User details",
  ADD_FORM_SUBTITLE: "Add user details",
  EDIT_FORM_TITLE: "Edit user",
  EDIT_FORM_SUBTITLE: "Edit user details",
  NAME_LABEL: "Name",
  NAME_PLACEHOLDER: "First and last name",
  EMAIL_LABEL: "Email",
  EMAIL_PLACEHOLDER: "username@email.com or Keycloak user ID",
  ROLE_SECTION_TITLE: "Assign a role",
  ROLE_LABEL: "Role",
  ADD_LABEL: "Add",
  SAVE_LABEL: "Save",
  CANCEL_LABEL: "Cancel",
  ADD_SUCCESS: (email: string) => `User "${email}" added successfully.`,
  ADD_ERROR: "Failed to add user. Please try again.",
  UPDATE_SUCCESS: "Member updated successfully.",
  UPDATE_ERROR: "Failed to update member. Please try again.",
  EMAIL_REQUIRED: "Email is required",
  NAME_REQUIRED: "Name is required",
  DUPLICATE_MEMBER: "This user is already a member of the project.",
} as const;

export const ADMINISTRATION_MEMBER_ROLE_OPTIONS = [
  { key: "viewer", value: "viewer", label: "Viewer" },
  { key: "member", value: "member", label: "Member" },
  { key: "admin", value: "admin", label: "Admin" },
] as const;

export type AdministrationMemberFormValues = {
  name: string;
  email: string;
  role: AccessUserRole;
};

export const ADMINISTRATION_MEMBER_FORM_DEFAULTS: AdministrationMemberFormValues = {
  name: "",
  email: "",
  role: "viewer",
};
