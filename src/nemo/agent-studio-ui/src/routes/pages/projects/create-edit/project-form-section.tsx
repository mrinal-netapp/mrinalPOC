import { useState, type ReactElement, type ReactNode } from "react";
import { IconChevronDown } from "@tabler/icons-react";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import "./project-form.scss";

interface ProjectFormSectionProps {
  title: string;
  status?: string;
  defaultExpanded?: boolean;
  children: ReactNode;
}

function ProjectFormSection({
  title,
  status,
  defaultExpanded = true,
  children,
}: ProjectFormSectionProps): ReactElement {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const sectionId = `${title.replace(/\s+/g, "-").toLowerCase()}-panel`;

  return (
    <section className="project-form-section">
      <button
        type="button"
        className="project-form-section__header"
        aria-expanded={expanded}
        aria-controls={sectionId}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <Typography
          Component="span"
          fontSize="fs16"
          boldness="semibold"
          className="project-form-section__title"
        >
          {title}
        </Typography>
        {status && (
          <Typography Component="span" fontSize="fs14" className="project-form-section__status">
            {status}
          </Typography>
        )}
        <IconChevronDown
          size={18}
          aria-hidden
          className={`project-form-section__chevron${expanded ? " project-form-section__chevron--expanded" : ""}`}
        />
      </button>

      {expanded && (
        <div id={sectionId} className="project-form-section__body">
          {children}
        </div>
      )}
    </section>
  );
}

export { ProjectFormSection };
