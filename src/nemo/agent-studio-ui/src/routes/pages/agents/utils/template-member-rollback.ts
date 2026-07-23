export type DeleteAgentFn = (args: { projectId: string; id: string }) => {
  unwrap: () => Promise<unknown>;
};

export type TemplateMemberRollbackResult = {
  attempted: number;
  deleted: string[];
  failed: Array<{ id: string; error: unknown }>;
};

function isNotFoundDeleteError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "status" in error
    && (error as { status: unknown }).status === 404
  );
}

/**
 * Best-effort compensation when template save fails after member agents were
 * created (mid-loop member POST or subsequent team POST). Deletes created
 * member agents in reverse order (LIFO).
 */
export async function rollbackCreatedTemplateMembers(
  projectId: string,
  memberIds: readonly string[],
  deleteAgent: DeleteAgentFn,
): Promise<TemplateMemberRollbackResult> {
  const deleted: string[] = [];
  const failed: Array<{ id: string; error: unknown }> = [];

  for (let index = memberIds.length - 1; index >= 0; index -= 1) {
    const id = memberIds[index];
    try {
      await deleteAgent({ projectId, id }).unwrap();
      deleted.push(id);
    } catch (error) {
      if (isNotFoundDeleteError(error)) {
        deleted.push(id);
        continue;
      }
      console.warn(`Failed to roll back template member agent ${id}:`, error);
      failed.push({ id, error });
    }
  }

  return {
    attempted: memberIds.length,
    deleted,
    failed,
  };
}
