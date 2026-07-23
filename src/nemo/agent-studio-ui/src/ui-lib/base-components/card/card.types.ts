import type { VariantProps } from "class-variance-authority"
import type { ReactNode } from "react"

import type { ButtonProps } from "@/ui-lib/base-components/button/button"
import type { FontSize, Boldness } from "@/ui-lib/types/typography.types"
import type { cardBlockVariants } from "./card.variants"

interface CardProps {
  children: ReactNode
  className?: string
  onClick?: () => void
  isDisabled?: boolean
}

interface CardHeaderProps {
  icon?: ReactNode
  title: string
  subtitle?: string
  orientation?: "horizontal" | "vertical"
  /** Maximum 2 actions are rendered; extras are truncated */
  actions?: ReactNode[]
  hasSeparator?: boolean
  className?: string
}

interface CardFooterBaseProps {
  hasSeparator?: boolean
  /** Maximum 2 actions are rendered; extras are truncated */
  actions?: ButtonProps[]
  children?: ReactNode
  className?: string
}

interface CardFooterDefaultProps extends CardFooterBaseProps {
  variant?: "default"
  alignment?: "start" | "center" | "end"
  cancelButton?: ButtonProps
}

interface CardFooterFillProps extends CardFooterBaseProps {
  variant: "fill"
  alignment?: never
  cancelButton?: never
}

type CardFooterProps = CardFooterDefaultProps | CardFooterFillProps

interface CardContentProps {
  children: ReactNode
  className?: string
}

interface CardContentLayoutProps {
  /** Number of equal-width columns in the grid */
  columns: number
  children: ReactNode
  className?: string
}

type CardBlockType =
  | "key-value"
  | "metric"
  | "description"
  | "status"
  | "list"
  | "info-row"
  | "link-row"
  | "progress"

interface CardBlockProps extends VariantProps<typeof cardBlockVariants> {
  hasSeparator?: boolean
  hasSideSeparator?: boolean
  onClick?: () => void
  isDisabled?: boolean
  children: ReactNode
  className?: string
}

type CardBlockStatusType = "success" | "error" | "warning" | "info" | "neutral"

interface CardBlockLabelProps {
  isEllipsis?: boolean
  children: ReactNode
  className?: string
}

interface CardBlockValueProps {
  isEllipsis?: boolean
  children: ReactNode
  className?: string
}

interface CardBlockMetricProps {
  value: ReactNode
  units?: ReactNode
  valueSize?: FontSize
  valueType?: Boldness
  unitSize?: FontSize
  unitType?: Boldness
  icon?: ReactNode
  orientation?: "horizontal" | "vertical"
  subtitle?: ReactNode
  className?: string
}

interface CardBlockStatusProps {
  status: CardBlockStatusType
  children: ReactNode
  className?: string
}

interface KeyValueRow {
  label: string
  value: ReactNode
}

interface CardBlockKeyValueListProps {
  rows: KeyValueRow[]
  className?: string
}

export type {
  CardProps,
  CardHeaderProps,
  CardFooterProps,
  CardContentProps,
  CardContentLayoutProps,
  CardBlockType,
  CardBlockProps,
  CardBlockStatusType,
  CardBlockLabelProps,
  CardBlockValueProps,
  CardBlockMetricProps,
  CardBlockStatusProps,
  KeyValueRow,
  CardBlockKeyValueListProps,
}
