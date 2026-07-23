import { useMemo, type ReactElement } from "react"
import { useNavigate } from "react-router"

import { useListProjectsQuery } from "@/api/project-api.slice"
import { useAuth } from "@/contexts/auth"
import { Button } from "@/ui-lib/base-components/button/button"
import {
  OVERVIEW_CREATE_PROJECT_TITLE,
  OVERVIEW_FEATURES,
  OVERVIEW_HERO,
  type OverviewFeature,
} from "./overview.consts"
import "./overview-page.scss"

function OverviewPage(): ReactElement {
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const { data, isLoading } = useListProjectsQuery(undefined, {
    skip: authLoading || !user?.id,
  })
  const hasProjects = (data?.projects?.length ?? 0) > 0

  const features = useMemo<OverviewFeature[]>(() => {
    const launchProjectFeature = OVERVIEW_FEATURES[0] as OverviewFeature

    if (!hasProjects) {
      return [launchProjectFeature]
    }

    return OVERVIEW_FEATURES.map((feature, index) =>
      index === 0 ? { ...feature, title: OVERVIEW_CREATE_PROJECT_TITLE } : feature,
    )
  }, [hasProjects])
  const isSingleFeature = features.length === 1

  return (
    <div className="overview-page">
      <section className="overview-page__hero" aria-labelledby="overview-page-title">
        <div className="overview-page__hero-content">
          <h1 id="overview-page-title" className="overview-page__title">
            {OVERVIEW_HERO.title}
          </h1>
          <p className="overview-page__tagline">{OVERVIEW_HERO.tagline}</p>
          <p className="overview-page__description">{OVERVIEW_HERO.description}</p>
        </div>
      </section>

      {!isLoading && (
        <section className="overview-page__features" aria-label="Agent Studio getting started actions">
          <div className={`overview-page__grid${isSingleFeature ? " overview-page__grid--single" : ""}`}>
            {features.map((feature) => (
              <article key={feature.to} className="overview-page__tile">
                <div className="overview-page__tile-icon" aria-hidden>
                  <img src={feature.icon} width={72} height={72} alt="" />
                </div>
                <h2 className="overview-page__tile-title">{feature.title}</h2>
                <p className="overview-page__tile-description">{feature.description}</p>
                <Button
                  className="overview-page__tile-action"
                  variant="solid"
                  label={feature.buttonLabel}
                  type="button"
                  onClick={() => navigate(feature.to)}
                />
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

export { OverviewPage }
