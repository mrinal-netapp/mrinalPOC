import type { ReactElement } from "react";

import { Typography } from "@/ui-lib/base-components/typography/typography";

import { TEMPLATE_REQUIRED_LABEL } from "../configure-dialogs/template-agent-config-dialog/template-agent-config-dialog.consts";

function TemplateRequiredLabel(): ReactElement {
  return (
    <Typography
      fontSize="fs13"
      color="var(--notification-error)"
      className="agent-form__template-required-label"
    >
      {TEMPLATE_REQUIRED_LABEL}
    </Typography>
  );
}

export { TemplateRequiredLabel };
