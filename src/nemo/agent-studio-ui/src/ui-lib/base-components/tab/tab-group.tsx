import { Tabs } from "@base-ui/react/tabs"
import type { VariantProps } from "class-variance-authority"
import type { ReactNode, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Tab } from "./tab"
import type { TabItem } from "./tab"
import { tabVariants } from "./tab.variants"
import "./tab-group.scss"

interface TabGroupProps {
  /** At least one tab must be provided — an empty array results in nothing being rendered. */
  tabs: TabItem[]
  activeTabId?: string
  variant?: VariantProps<typeof tabVariants>["variant"]
  fitting?: VariantProps<typeof tabVariants>["fitting"]
  orientation?: "horizontal" | "vertical"
  disableAll?: boolean
  onTabChange?: (tabId: string) => void
  ariaLabel?: string
  className?: string
  children?: ReactNode
}

interface TabContentProps {
  tabId: string
  keepMounted?: boolean
  className?: string
  children: ReactNode
}

function TabGroup({
  tabs,
  activeTabId,
  variant = "general",
  fitting = "fit-content",
  orientation = "horizontal",
  disableAll = false,
  onTabChange,
  ariaLabel,
  className,
  children,
}: TabGroupProps): ReactElement | null {
  if (tabs.length === 0) return null

  const firstEnabledTab = disableAll ? undefined : tabs.find((t) => !t.isDisabled)
  const isControlled = activeTabId !== undefined

  const rootProps: Tabs.Root.Props = {
    orientation,
    ...(isControlled
      ? { value: activeTabId }
      : { defaultValue: firstEnabledTab?.id ?? tabs[0]?.id }),
    ...(onTabChange && {
      onValueChange: (value: Tabs.Tab.Value) => {
        onTabChange(value as string)
      },
    }),
  }

  return (
    <Tabs.Root
      data-slot="tab-group"
      className={cn(
        "tab-group",
        `tab-group--${variant}`,
        `tab-group--${orientation}`,
        className,
      )}
      {...rootProps}
    >
      <Tabs.List aria-label={ariaLabel} className={cn("tab-group__list", `tab-group__list--${variant}`)}>
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            {...tab}
            isDisabled={tab.isDisabled || disableAll}
            variant={variant}
            fitting={fitting}
          />
        ))}
        <Tabs.Indicator className="tab-group__indicator" />
      </Tabs.List>
      {children}
    </Tabs.Root>
  )
}

function TabContent({ tabId, keepMounted = false, className, children }: TabContentProps): ReactElement {
  return (
    <Tabs.Panel value={tabId} keepMounted={keepMounted} className={cn("tab-content", className)}>
      {children}
    </Tabs.Panel>
  )
}

export { TabGroup, TabContent }
export type { TabGroupProps, TabContentProps }
