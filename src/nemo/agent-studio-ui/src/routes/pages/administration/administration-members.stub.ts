import type { MemberLastActiveDisplay, MemberListTableRow } from "./administration-members.utils";

type StubMemberSeed = {
  name: string;
  email: string;
  displayRole: "Admin" | "Member" | "Viewer";
  lastActive: MemberLastActiveDisplay;
};

const STUB_MEMBER_SEEDS: StubMemberSeed[] = [
  { name: "Al Smith", email: "al@example.com", displayRole: "Admin", lastActive: { kind: "relative", label: "Today" } },
  { name: "Ben Cohen", email: "ben@example.com", displayRole: "Viewer", lastActive: { kind: "relative", label: "1 day ago" } },
  { name: "Dana Thomas", email: "dana@example.com", displayRole: "Viewer", lastActive: { kind: "relative", label: "3 days ago" } },
  { name: "Dylan Johns", email: "dylan@example.com", displayRole: "Member", lastActive: { kind: "relative", label: "4 days ago" } },
  { name: "Eli Bar", email: "eli@example.com", displayRole: "Admin", lastActive: { kind: "relative", label: "Today" } },
  { name: "Ervin Gilbert", email: "ervin@example.com", displayRole: "Viewer", lastActive: { kind: "never" } },
  { name: "James Jean", email: "james@example.com", displayRole: "Member", lastActive: { kind: "relative", label: "2 days ago" } },
  { name: "Horace Kruger", email: "horace@example.com", displayRole: "Admin", lastActive: { kind: "relative", label: "1 day ago" } },
  { name: "Owen Katz", email: "owen@example.com", displayRole: "Viewer", lastActive: { kind: "relative", label: "Today" } },
  { name: "Prince Edwards", email: "prince@example.com", displayRole: "Member", lastActive: { kind: "relative", label: "2 days ago" } },
  { name: "Uri Or", email: "uri@example.com", displayRole: "Viewer", lastActive: { kind: "never" } },
  { name: "Veronika Shultz", email: "veronika@example.com", displayRole: "Admin", lastActive: { kind: "relative", label: "3 days ago" } },
];

function toApiMemberRole(displayRole: StubMemberSeed["displayRole"]): MemberListTableRow["role"] {
  if (displayRole === "Admin") return "admin";
  if (displayRole === "Viewer") return "viewer";
  return "member";
}

function createStubMemberRow(seed: StubMemberSeed): MemberListTableRow {
  return {
    id: seed.email,
    userId: seed.email,
    name: seed.name,
    email: seed.email,
    role: toApiMemberRole(seed.displayRole),
    displayRole: seed.displayRole,
    lastActive: seed.lastActive,
    createdAt: new Date().toISOString(),
  };
}

const STUB_MEMBER_ROWS: MemberListTableRow[] = STUB_MEMBER_SEEDS.map(createStubMemberRow);

function shouldUseStubMembers(isError: boolean, error: unknown): boolean {
  if (!import.meta.env.DEV || !isError) {
    return false;
  }

  return (
    typeof error === "object"
    && error !== null
    && "status" in error
    && error.status === 401
  );
}

export { STUB_MEMBER_ROWS, shouldUseStubMembers };
