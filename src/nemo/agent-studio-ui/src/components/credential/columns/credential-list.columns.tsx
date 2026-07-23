import type { ColumnDef } from "@tanstack/react-table";
import type { Credential } from "@/routes/pages/credentials/credential.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";

// Extend Credential with the `id` field BaseTable requires
export interface CredentialTableRow extends Credential {
  id: string;
}

export interface CredentialColumnsCallbacks {
  actionMenuItems:
    | ActionMenuItem<CredentialTableRow>[]
    | ((row: CredentialTableRow) => ActionMenuItem<CredentialTableRow>[]);
}

// -- Helpers --

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

function expiryLabel(iso?: string): { text: string; color?: string } {
  if (!iso) return { text: "—" };
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const text = formatDate(iso);
  if (days < 0) return { text: `${text} (expired)`, color: "var(--notification-error)" };
  if (days <= 7) return { text: `${text} (${days}d)`, color: "var(--notification-warning)" };
  return { text };
}

function usedByLabel(summary?: Credential["dependentsSummary"]): string {
  if (!summary || summary.total === 0) return "—";
  const breakdown = Object.entries(summary.byKind)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  return `${summary.total} (${breakdown})`;
}

// -- Column factory --

function createCredentialListColumns(
  callbacks: CredentialColumnsCallbacks,
): ColumnDef<CredentialTableRow>[] {
  return [
    // 1. Name
    {
      accessorKey: "name",
      header: "Name",
      size: 200,
      minSize: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.name}
        </Typography>
      ),
    },

    // 2. Provider
    {
      accessorKey: "provider",
      header: "Provider",
      size: 130,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.provider}
        </Typography>
      ),
    },

    // 3. Description
    {
      accessorKey: "description",
      header: "Description",
      size: 220,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <Typography
          Component="span"
          fontSize="fs14"
          boldness="regular"
          color={row.original.description ? undefined : "var(--text-disabled)"}
        >
          {row.original.description ?? "—"}
        </Typography>
      ),
    },

    // 4. Expiry
    {
      accessorKey: "expiresAt",
      header: "Expiry",
      size: 180,
      cell: ({ row }) => {
        const { text, color } = expiryLabel(row.original.expiresAt);
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {text}
          </Typography>
        );
      },
    },

    // 5. Version (rotation count)
    {
      accessorKey: "rotationVersion",
      header: "Version",
      size: 90,
      cell: ({ row }) => (
        <Typography
          Component="span"
          fontSize="fs14"
          boldness="regular"
          color={row.original.rotationVersion == null ? "var(--text-disabled)" : undefined}
        >
          {row.original.rotationVersion ?? "—"}
        </Typography>
      ),
    },

    // 6. Used by
    {
      id: "used_by",
      header: "Used by",
      size: 180,
      minSize: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const label = usedByLabel(row.original.dependentsSummary);
        return (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color={label === "—" ? "var(--text-disabled)" : undefined}
          >
            {label}
          </Typography>
        );
      },
    },

    // 7. Created
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 150,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDate(row.original.createdAt)}
        </Typography>
      ),
    },

    // 8. Actions
    {
      id: "actions",
      header: "Actions",
      size: 75,
      minSize: 75,
      maxSize: 75,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const items =
          typeof callbacks.actionMenuItems === "function"
            ? callbacks.actionMenuItems(row.original)
            : callbacks.actionMenuItems;
        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={items}
          />
        );
      },
    },
  ];
}

export { createCredentialListColumns };
export type { ActionMenuItem };
