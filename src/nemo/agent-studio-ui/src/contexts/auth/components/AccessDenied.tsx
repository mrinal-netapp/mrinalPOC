import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

const DEFAULT_TITLE = "Access denied";
const DEFAULT_DESCRIPTION =
  "Your account is signed in but does not have a platform role required to use Agent Studio. " +
  "Ask an administrator to assign the platform-member or platform-admin role in Keycloak.";

type AccessDeniedProps = {
  errorCode: string | null;
  /** Optional heading override. Defaults to the platform-role denial copy. */
  title?: string;
  /** Optional body override. Defaults to the platform-role denial copy. */
  description?: string;
};

function AccessDenied({
  errorCode,
  title = DEFAULT_TITLE,
  description = DEFAULT_DESCRIPTION,
}: AccessDeniedProps): ReactElement {
  return (
    <div className="auth-access-denied">
      <Typography Component="h1" fontSize="fs20" boldness="semibold">
        {title}
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular">
        {description}
      </Typography>
      {errorCode != null && (
        <Typography fontSize="fs12" boldness="regular" className="auth-access-denied__code">
          {errorCode}
        </Typography>
      )}
    </div>
  );
}

export { AccessDenied };
