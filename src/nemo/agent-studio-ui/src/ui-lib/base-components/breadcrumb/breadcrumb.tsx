import type { ReactElement } from "react"
import { Link } from "react-router"
import { IconChevronRight, IconDots } from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu"
import "./breadcrumb.scss"

// -- Types

interface BreadcrumbItem {
  label: string
  href: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
  className?: string
}

// -- Internal sub-components

function BreadcrumbLink({ label, href }: BreadcrumbItem): ReactElement {
  return (
    <li data-slot="breadcrumb-item" className="breadcrumb__item">
      <Link to={href} data-slot="breadcrumb-link" className="breadcrumb__link">
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
          {label}
        </Typography>
      </Link>
    </li>
  )
}

function BreadcrumbPage({ label }: { label: string }): ReactElement {
  return (
    <li data-slot="breadcrumb-item" className="breadcrumb__item">
      <span
        data-slot="breadcrumb-page"
        aria-current="page"
        className="breadcrumb__page"
      >
        <Typography Component="span" fontSize="fs14" boldness="semibold">
          {label}
        </Typography>
      </span>
    </li>
  )
}

function BreadcrumbSeparator(): ReactElement {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className="breadcrumb__separator"
    >
      <IconChevronRight size={14} />
    </li>
  )
}

function BreadcrumbEllipsis({ items }: { items: BreadcrumbItem[] }): ReactElement {
  return (
    <li data-slot="breadcrumb-item" className="breadcrumb__item">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          data-slot="breadcrumb-ellipsis"
          className="breadcrumb__ellipsis"
          aria-label="Toggle collapsed breadcrumbs"
        >
          <IconDots size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.href}
              render={<Link to={item.href} className="breadcrumb__ellipsis-link" />}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

// -- Breadcrumb

function Breadcrumb({ items, className }: BreadcrumbProps): ReactElement | null {
  if (items.length === 0) return null

  const last = items[items.length - 1]
  const visibleLinks = items.length <= 3 ? items.slice(0, -1) : [items[0]]
  const collapsedItems = items.length > 3 ? items.slice(1, -1) : []

  return (
    <nav
      aria-label="breadcrumb"
      data-slot="breadcrumb"
      className={cn("breadcrumb", className)}
    >
      <ol data-slot="breadcrumb-list" className="breadcrumb__list">
        {visibleLinks.map((item, index) => (
          <ItemSeparator key={item.href} index={index}>
            <BreadcrumbLink {...item} />
          </ItemSeparator>
        ))}

        {collapsedItems.length > 0 && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbEllipsis items={collapsedItems} />
          </>
        )}

        {items.length > 1 && <BreadcrumbSeparator />}
        <BreadcrumbPage label={last.label} />
      </ol>
    </nav>
  )
}

// Helper to interleave separators between visible links
function ItemSeparator({ children, index }: { children: ReactElement; index: number }): ReactElement {
  return (
    <>
      {index > 0 && <BreadcrumbSeparator />}
      {children}
    </>
  )
}

export { Breadcrumb }
export type { BreadcrumbProps, BreadcrumbItem }
