import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { useNavigate } from "react-router";
import {
  IconChevronDown,
  IconExternalLink,
  IconSearch,
  IconX,
} from "@tabler/icons-react";

import { ProjectIcon } from "@/components/projects/project-icon/project-icon";
import { useProject } from "@/contexts/project";
import { projectsPaths } from "@/routes/pages/projects/projects.consts";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
} from "@/ui-lib/base-components/dialog/dialog";
import { cn } from "@/ui-lib/lib/utils";
import { buttonVariants } from "@/ui-lib/base-components/button/button.variants";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { PROJECT_SWITCHER_STRINGS } from "./project-switcher.consts";
import "./project-switcher.scss";

function ProjectSwitcher(): ReactElement {
  const navigate = useNavigate();
  const {
    activeProject,
    accessibleProjects: projects,
    loading: isLoading,
    error,
    switchProject,
  } = useProject();
  const isError = error != null;
  const activeProjectId = activeProject?.id ?? "";
  const displayName = activeProject?.name || activeProject?.id || "";

  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingProjectId, setPendingProjectId] = useState("");
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(query));
  }, [projects, searchQuery]);

  const triggerLabel = displayName || PROJECT_SWITCHER_STRINGS.UNNAMED_PROJECT;

  useEffect(() => {
    setPortalContainer(document.body);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSearchQuery("");
      return;
    }
    setPendingProjectId(activeProjectId);
  }, [activeProjectId]);

  const handleCancel = useCallback(() => {
    setOpen(false);
  }, []);

  const handleManageProjects = useCallback(() => {
    setOpen(false);
    navigate(projectsPaths.root);
  }, [navigate]);

  const handleSwitch = useCallback(() => {
    if (pendingProjectId && pendingProjectId !== activeProjectId) {
      switchProject(pendingProjectId);
    }
    setOpen(false);
  }, [activeProjectId, pendingProjectId, switchProject]);

  const canSwitch = pendingProjectId !== "" && pendingProjectId !== activeProjectId;

  return (
    <>
      <button
        type="button"
        className={cn(
          buttonVariants({ variant: "flat", size: "medium" }),
          "project-switcher__trigger",
        )}
        aria-label={PROJECT_SWITCHER_STRINGS.OPEN_PANEL_ARIA(triggerLabel)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="project-switcher-trigger"
        onClick={() => handleOpenChange(true)}
      >
        <span className="project-switcher__trigger-content">
          <Typography
            Component="span"
            fontSize="fs12"
            boldness="regular"
            color="var(--text-secondary)"
            className="project-switcher__trigger-label"
          >
            {PROJECT_SWITCHER_STRINGS.TRIGGER_LABEL}
          </Typography>
          <span className="project-switcher__trigger-name-row">
            <Typography
              Component="span"
              fontSize="fs14"
              boldness="semibold"
              className="project-switcher__trigger-name"
            >
              {triggerLabel}
            </Typography>
            <IconChevronDown size={16} aria-hidden className="project-switcher__trigger-icon" />
          </span>
        </span>
      </button>

      <Dialog open={open} onOpenChange={handleOpenChange} container={portalContainer}>
        <DialogPopup showCloseButton={false} className="project-switcher-panel">
          <div className="project-switcher-panel__inner">
            <header className="project-switcher-panel__header">
              <DialogTitle className="project-switcher-panel__title">
                {PROJECT_SWITCHER_STRINGS.PANEL_TITLE}
              </DialogTitle>
              <button
                type="button"
                className="project-switcher-panel__manage-link"
                onClick={handleManageProjects}
              >
                {PROJECT_SWITCHER_STRINGS.MANAGE_PROJECTS_LABEL}
                <IconExternalLink size={14} aria-hidden />
              </button>
            </header>

            <div className="project-switcher-panel__body">
              <div className="project-switcher-panel__search">
                <IconSearch size={16} aria-hidden className="project-switcher-panel__search-icon" />
                <input
                  type="search"
                  className="project-switcher-panel__search-input"
                  placeholder={PROJECT_SWITCHER_STRINGS.SEARCH_PLACEHOLDER}
                  aria-label={PROJECT_SWITCHER_STRINGS.SEARCH_ARIA_LABEL}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="project-switcher-panel__search-clear"
                    aria-label="Clear search"
                    onClick={() => setSearchQuery("")}
                  >
                    <IconX size={16} aria-hidden />
                  </button>
                )}
              </div>

              <div
                className="project-switcher-panel__list"
                role="listbox"
                aria-label={PROJECT_SWITCHER_STRINGS.SELECT_PROJECT_ARIA}
              >
                {isLoading && (
                  <div className="project-switcher-panel__loading">
                    <Spinner size="fitContent" />
                  </div>
                )}

                {!isLoading && isError && (
                  <Typography Component="p" fontSize="fs14" color="var(--notification-error)">
                    Failed to load projects.
                  </Typography>
                )}

                {!isLoading && !isError && projects.length === 0 && (
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {PROJECT_SWITCHER_STRINGS.NO_PROJECTS}
                  </Typography>
                )}

                {!isLoading && !isError && projects.length > 0 && filteredProjects.length === 0 && (
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {PROJECT_SWITCHER_STRINGS.NO_RESULTS}
                  </Typography>
                )}

                {!isLoading && !isError && filteredProjects.length > 0 && (
                  filteredProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      role="option"
                      aria-selected={pendingProjectId === project.id}
                      className={cn(
                        "project-switcher-panel__item",
                        pendingProjectId === project.id && "project-switcher-panel__item--selected",
                      )}
                      onClick={() => setPendingProjectId(project.id)}
                    >
                      <ProjectIcon className="project-switcher-panel__item-icon" />
                      <Typography Component="span" fontSize="fs14" boldness="regular">
                        {project.name}
                      </Typography>
                    </button>
                  ))
                )}
              </div>
            </div>

            <footer className="project-switcher-panel__footer">
              <Button
                variant="solid"
                size="medium"
                label={PROJECT_SWITCHER_STRINGS.SWITCH_LABEL}
                onClick={handleSwitch}
                isDisabled={!canSwitch}
              />
              <Button
                variant="outline"
                size="medium"
                label={PROJECT_SWITCHER_STRINGS.CANCEL_LABEL}
                onClick={handleCancel}
              />
            </footer>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export { ProjectSwitcher };
