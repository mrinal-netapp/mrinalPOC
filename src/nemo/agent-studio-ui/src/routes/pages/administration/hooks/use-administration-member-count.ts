import { useMemo } from "react";

import { useListProjectMembersQuery } from "@/api/project-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { STUB_MEMBER_ROWS, shouldUseStubMembers } from "../administration-members.stub";

function useAdministrationMemberCount(): number | null {
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId);

  const {
    data: membersData,
    isError,
    error,
    isLoading,
  } = useListProjectMembersQuery(activeProjectId, { skip: !activeProjectId });

  const useStubData = shouldUseStubMembers(isError, error);

  return useMemo(() => {
    if (!activeProjectId) {
      return null;
    }

    if (useStubData) {
      return STUB_MEMBER_ROWS.length;
    }

    if (isLoading && membersData === undefined) {
      return null;
    }

    if (isError) {
      return null;
    }

    return membersData?.members?.length ?? 0;
  }, [
    activeProjectId,
    isError,
    isLoading,
    membersData,
    useStubData,
  ]);
}

export { useAdministrationMemberCount };
