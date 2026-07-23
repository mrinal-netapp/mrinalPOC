import type { ReactElement } from "react";
import { useParams, Navigate } from "react-router";

import { useGetCredentialQuery } from "../credential-api.slice";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { credentialPaths } from "../credentials.consts";
import { CredentialForm } from "./credential-form";
import "./credential-form.scss";

function CredentialEditPage(): ReactElement {
  const { credId } = useParams<{ credId: string }>();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetCredentialQuery(
    { projectId, id: credId ?? "" },
    { skip: !credId || !projectId },
  );

  if (!credId) {
    return <Navigate to={credentialPaths.root} replace />;
  }

  if (isLoading) {
    return (
      <div className="cred-form-page__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="cred-form-page__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load credential.
        </Typography>
      </div>
    );
  }

  return <CredentialForm key={credId} isEdit initialData={data} />;
}

export { CredentialEditPage };
