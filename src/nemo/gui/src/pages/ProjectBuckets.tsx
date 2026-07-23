import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'
import { VolumeListing } from '../components/datasource/VolumeListing'
import { BucketFormData } from '../types/bucket'
import { VOLUME_WIZARD_PREFILL_STATE_KEY } from '../constants/navigationState'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
})

export default function ProjectBuckets() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
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

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Volumes</h1>
      <VolumeListing projectId={projectId!} initialPrefill={prefill} />
    </div>
  )
}
