import { type ReactElement, type ReactNode } from "react"
import { IconActivity, IconChartAreaLine, IconFileText, IconTimeline } from "@tabler/icons-react"
import { Button } from "@/ui-lib/base-components/button/button"
import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import { getObservabilityUrls } from "@/consts/sidebar-nav.consts"
import { useAuth } from "@/contexts/auth"
import "./observability-page.scss"

interface ObservabilityTile {
  icon: ReactNode
  title: string
  description: string
  url: string
}

function ObservabilityPage(): ReactElement {
  const activeProjectId = useAppSelector(projectContextSelector.activeProjectId)
  const { token } = useAuth()
  const urls = getObservabilityUrls(activeProjectId, token)

  const tiles: ObservabilityTile[] = [
    {
      icon: <IconFileText size={40} />,
      title: "Logs",
      description:
        "Browse recent log entries from instrumented services. Filter by service and inspect details in Loki.",
      url: urls.logs,
    },
    {
      icon: <IconChartAreaLine size={40} />,
      title: "Metrics",
      description:
        "Explore RED metrics filtered to your active project. Drill down by service, endpoint, or time range.",
      url: urls.metrics,
    },
    {
      icon: <IconTimeline size={40} />,
      title: "App Traces",
      description:
        "Trace distributed requests end-to-end with Grafana Tempo. Visualise latency, errors, and spans across all services.",
      url: urls.appTraces,
    },
    {
      icon: <IconActivity size={40} />,
      title: "Agent Traces",
      description:
        "Inspect LLM reasoning chains, tool calls, and token usage in Phoenix. Debug and evaluate agent behaviour in detail.",
      url: urls.agentTraces,
    },
  ]

  const handleOpen = (url: string) => {
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <div className="observability-page">
      <section className="observability-page__hero" aria-labelledby="observability-page-title">
        <div className="observability-page__hero-content">
          <h1 id="observability-page-title" className="observability-page__title">
            Observability
          </h1>
          <p className="observability-page__description">
            Monitor logs, metrics, and traces for your Agent Studio services. Metrics open with
            your active project pre-selected; logs and traces open in dedicated dashboards.
          </p>
        </div>
      </section>

      <section className="observability-page__tiles" aria-label="Observability tools">
        <div className="observability-page__grid">
          {tiles.map((tile) => (
            <article key={tile.title} className="observability-page__tile">
              <div className="observability-page__tile-icon" aria-hidden>
                {tile.icon}
              </div>
              <h2 className="observability-page__tile-title">{tile.title}</h2>
              <p className="observability-page__tile-description">{tile.description}</p>
              <Button
                variant="solid"
                label="Open"
                type="button"
                isDisabled={!tile.url}
                onClick={() => handleOpen(tile.url)}
              />
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

export { ObservabilityPage }
