import type { ReactElement } from "react";
import { IconCircles } from "@tabler/icons-react";

import { cn } from "@/ui-lib/lib/utils";
import "./project-icon.scss";

type ProjectIconSize = "sm" | "md";

interface ProjectIconProps {
  size?: ProjectIconSize;
  className?: string;
}

const PROJECT_ICON_SIZES: Record<ProjectIconSize, number> = {
  sm: 18,
  md: 24,
};

function ProjectIcon({ size = "sm", className }: ProjectIconProps): ReactElement {
  return (
    <IconCircles
      size={PROJECT_ICON_SIZES[size]}
      stroke={1.5}
      aria-hidden
      className={cn("project-icon", `project-icon--${size}`, className)}
    />
  );
}

export { ProjectIcon };
export type { ProjectIconProps, ProjectIconSize };
