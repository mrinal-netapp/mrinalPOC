import type { ReactNode } from "react"

type MetricItem = {
  icon: ReactNode
  value: string
  units?: string
  subtitle: string
}

type MetricsRowProps = {
  metrics: MetricItem[]
  className?: string
}

export type { MetricItem, MetricsRowProps }
