import type { ReactElement } from "react";
import { IconFolder, IconFile, IconFileOff } from "@tabler/icons-react";
import { useStore } from "@tanstack/react-store";

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import type { FolderScope } from "@/api/dataset.types";

interface ScopeSummaryItem {
  icon: ReactElement;
  value: string | number;
  label: string;
}

/**
 * Summary of the dataset's selected scope (included folders / files, excluded
 * files). Shared by the create (SpecSection) and edit (DataSourceScopeSection)
 * flows so both show the same panel.
 */
function ScopeSummary({ form }: { form: AnyReactFormApi }): ReactElement {
  const folderScope: FolderScope = useStore(form.store, (s) => s.values.spec.folder_scope);
  const paths: string[] | undefined = useStore(form.store, (s) => s.values.spec.paths);

  const includedFolders = folderScope === "custom"
    ? (paths?.length ?? 0)
    : "All";

  const items: ScopeSummaryItem[] = [
    { icon: <IconFolder size={20} />, value: includedFolders, label: "Included folders" },
    { icon: <IconFile size={20} />, value: "...", label: "Included files" },
    { icon: <IconFileOff size={20} />, value: "...", label: "Excluded files" },
  ];

  return (
    <div className="dset-form__scope-summary">
      <Typography Component="h3" fontSize="fs14" boldness="semibold">
        Scope summary
      </Typography>
      <div className="dset-form__scope-summary-stats">
        {items.map((item, idx) => (
          <div key={item.label} className="dset-form__scope-summary-item">
            {idx > 0 && <div className="dset-form__scope-summary-divider" />}
            <div className="dset-form__scope-summary-icon">{item.icon}</div>
            <div className="dset-form__scope-summary-text">
              <Typography Component="span" fontSize="fs20" boldness="semibold">
                {item.value}
              </Typography>
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                {item.label}
              </Typography>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export { ScopeSummary };
