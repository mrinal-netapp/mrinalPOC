import {
  makeStyles,
  tokens,
  Button,
} from '@fluentui/react-components'
import { Dismiss24Regular } from '@fluentui/react-icons'
import { useTabs, Tab } from '../contexts/TabContext'
import { useNavigate } from 'react-router-dom'

const useStyles = makeStyles({
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    overflowX: 'auto',
    overflowY: 'hidden',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    minWidth: '120px',
    maxWidth: '200px',
    transition: 'all 0.2s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  activeTab: {
    backgroundColor: tokens.colorBrandBackground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    color: tokens.colorBrandForeground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  tabLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: '13px',
  },
  closeButton: {
    minWidth: '20px',
    width: '20px',
    height: '20px',
    padding: 0,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
})

interface TabBarProps {
  onTabClick: (tab: Tab) => void
}

export default function TabBar({ onTabClick }: TabBarProps) {
  const styles = useStyles()
  const { tabs, activeTabId, removeTab, setActiveTab } = useTabs()
  const navigate = useNavigate()

  const handleTabClick = (tab: Tab) => {
    setActiveTab(tab.id)
    onTabClick(tab)
  }

  const handleClose = (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation()
    removeTab(tab.id)
    // Navigate to home if closing active tab and no tabs remain
    if (tabs.length === 1) {
      navigate('/')
    } else if (activeTabId === tab.id) {
      // Navigate to the next active tab
      const remainingTabs = tabs.filter((t) => t.id !== tab.id)
      if (remainingTabs.length > 0) {
        const nextTab = remainingTabs[remainingTabs.length - 1]
        handleTabClick(nextTab)
      } else {
        navigate('/')
      }
    }
  }

  if (tabs.length === 0) {
    return null
  }

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab} ${activeTabId === tab.id ? styles.activeTab : ''}`}
          onClick={() => handleTabClick(tab)}
        >
          {tab.icon && <span style={{ display: 'flex', alignItems: 'center' }}>{tab.icon}</span>}
          <span className={styles.tabLabel} title={tab.label}>
            {tab.label}
          </span>
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            size="small"
            className={styles.closeButton}
            onClick={(e) => handleClose(e, tab)}
          />
        </div>
      ))}
    </div>
  )
}

