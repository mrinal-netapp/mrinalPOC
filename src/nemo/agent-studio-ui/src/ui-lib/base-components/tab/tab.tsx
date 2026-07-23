import { Tabs } from "@base-ui/react/tabs"
import type { VariantProps } from "class-variance-authority"
import type { ReactNode, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { tabVariants } from "./tab.variants"
import "./tab.scss"

interface TabItem {
  id: string
  label: string
  icon?: ReactNode
  count?: number
  isDisabled?: boolean
}

interface TabProps extends TabItem {
  variant?: VariantProps<typeof tabVariants>["variant"]
  fitting?: VariantProps<typeof tabVariants>["fitting"]
  className?: string
}

function Tab({
  id,
  label,
  icon,
  count,
  isDisabled = false,
  variant = "general",
  fitting = "fit-content",
  className,
}: TabProps): ReactElement {
  const isGeneral = variant === "general"

  return (
    <Tabs.Tab
      value={id}
      disabled={isDisabled}
      data-slot="tab"
      className={cn(tabVariants({ variant, fitting }), className)}
    >
      <span className="tab__content">
        {icon !== undefined && <span className="tab__icon">{icon}</span>}
        <Typography
          Component="span"
          fontSize={isGeneral ? "fs14" : "fs16"}
          boldness={isGeneral ? "semibold" : "regular"}
          className="tab__label"
          isDisabled={isDisabled}
        >
          {label}
        </Typography>
        {count !== undefined && (
          <Typography
            Component="span"
            fontSize={isGeneral ? "fs14" : "fs16"}
            boldness={isGeneral ? "semibold" : "regular"}
            className="tab__count"
            isDisabled={isDisabled}
          >
            ({count})
          </Typography>
        )}
      </span>
    </Tabs.Tab>
  )
}

export { Tab }
export type { TabItem, TabProps }
