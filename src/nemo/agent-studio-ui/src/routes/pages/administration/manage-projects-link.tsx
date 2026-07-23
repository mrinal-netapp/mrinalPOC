import type { ReactElement } from "react";
import { useNavigate } from "react-router";
import { IconChevronRight } from "@tabler/icons-react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { projectsPaths } from "@/routes/pages/projects/projects.consts";
import { ADMINISTRATION_STRINGS } from "./administration.consts";
import "./manage-projects-link.scss";

function ManageProjectsLink(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="manage-projects-link">
      <Typography fontSize="fs12" boldness="semibold" className="manage-projects-link__section-label">
        {ADMINISTRATION_STRINGS.PROJECTS_SECTION_LABEL}
      </Typography>
      <Button
        variant="flat"
        size="medium"
        className="manage-projects-link__action"
        label={ADMINISTRATION_STRINGS.MANAGE_PROJECTS_LABEL}
        icon={<IconChevronRight size={16} aria-hidden />}
        onClick={() => navigate(projectsPaths.root)}
      />
    </div>
  );
}

export { ManageProjectsLink };
