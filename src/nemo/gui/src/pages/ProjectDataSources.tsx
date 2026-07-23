import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Text,
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionPanel,
} from '@fluentui/react-components'
import { ConnectorListing } from '../components/datasource/ConnectorListing'
import { VolumeListing } from '../components/datasource/VolumeListing'
import { BucketFormData } from '../types/bucket'
import { VOLUME_WIZARD_PREFILL_STATE_KEY } from '../constants/navigationState'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  accordion: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXL,
  },
  sectionSurface: {
    marginTop: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalM,
    paddingBottom: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  subtitle: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
    marginTop: '4px',
  },
  sectionHeader: {
    fontSize: '16px',
    fontWeight: 600,
  },
})

export default function ProjectDataSources() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  const [volumeRefreshKey, setVolumeRefreshKey] = useState(0)
  const [prefill, setPrefill] = useState<BucketFormData | undefined>(undefined)

  useEffect(() => {
    const pre = (location.state as Record<string, unknown> | null)?.[
      VOLUME_WIZARD_PREFILL_STATE_KEY
    ] as BucketFormData | undefined
    if (!pre || typeof pre !== 'object' || typeof (pre as BucketFormData).name !== 'string') return

    setPrefill(pre)
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: {} },
    )
  }, [location.state, location.pathname, location.search, location.hash, navigate])

  const handleResourcesRegistered = () => {
    setVolumeRefreshKey((k) => k + 1)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Data Sources</h1>
          <Text className={styles.subtitle}>
            Manage connectors and volumes for your project
          </Text>
        </div>
      </div>

      <Accordion
        className={styles.accordion}
        multiple
        collapsible
        defaultOpenItems={['connectors', 'volumes']}
      >
        <AccordionItem value="connectors">
          <AccordionHeader>
            <span className={styles.sectionHeader}>Connectors</span>
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.sectionSurface}>
              <ConnectorListing
                projectId={projectId!}
                onResourcesRegistered={handleResourcesRegistered}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>

        <AccordionItem value="volumes">
          <AccordionHeader>
            <span className={styles.sectionHeader}>Volumes</span>
          </AccordionHeader>
          <AccordionPanel>
            <div className={styles.sectionSurface}>
              <VolumeListing
                projectId={projectId!}
                initialPrefill={prefill}
                refreshKey={volumeRefreshKey}
              />
            </div>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
