import { useState } from 'react'
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Input,
  Field,
  Switch,
} from '@fluentui/react-components'
import {
  Settings24Regular,
  Person24Regular,
  Shield24Regular,
  Database24Regular,
  Cube24Regular,
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    height: '100%',
    gap: '16px',
  },
  sidebar: {
    width: '250px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    gap: '8px',
  },
  sidebarItem: {
    padding: '12px 16px',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '14px',
    color: tokens.colorNeutralForeground1,
    transition: 'all 0.2s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  sidebarItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  content: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
  },
  sectionTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    marginBottom: '16px',
  },
  formGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    marginBottom: '24px',
  },
  card: {
    marginBottom: '16px',
  },
})

type SettingsSection = 'general' | 'account' | 'security' | 'database' | 'deployments'

export default function Settings() {
  const styles = useStyles()
  const [activeSection, setActiveSection] = useState<SettingsSection>('general')
  const [formData, setFormData] = useState({
    appName: 'AgentStudio',
    theme: 'light',
    language: 'en',
    email: '',
    notifications: true,
    twoFactorAuth: false,
    dbHost: '',
    dbPort: '5432',
    apiTimeout: '30',
  })

  const sections = [
    { id: 'general' as SettingsSection, label: 'General', icon: <Settings24Regular /> },
    { id: 'account' as SettingsSection, label: 'Account', icon: <Person24Regular /> },
    { id: 'security' as SettingsSection, label: 'Security', icon: <Shield24Regular /> },
    { id: 'database' as SettingsSection, label: 'Database', icon: <Database24Regular /> },
    { id: 'deployments' as SettingsSection, label: 'Deployments', icon: <Cube24Regular /> },
  ]

  const handleSave = () => {
    // TODO: Implement save functionality
    console.log('Saving settings:', formData)
  }

  const renderSectionContent = () => {
    switch (activeSection) {
      case 'general':
        return (
          <div>
            <h2 className={styles.sectionTitle}>General Settings</h2>
            <Card className={styles.card}>
              <CardHeader header={<Text weight="semibold">Application</Text>} />
              <div className={styles.formGroup} style={{ padding: '16px' }}>
                <Field label="Application Name">
                  <Input
                    value={formData.appName}
                    onChange={(_, data) => setFormData({ ...formData, appName: data.value })}
                  />
                </Field>
                <Field label="Theme">
                  <Input
                    value={formData.theme}
                    onChange={(_, data) => setFormData({ ...formData, theme: data.value })}
                  />
                </Field>
                <Field label="Language">
                  <Input
                    value={formData.language}
                    onChange={(_, data) => setFormData({ ...formData, language: data.value })}
                  />
                </Field>
              </div>
            </Card>
          </div>
        )

      case 'account':
        return (
          <div>
            <h2 className={styles.sectionTitle}>Account Settings</h2>
            <Card className={styles.card}>
              <CardHeader header={<Text weight="semibold">Profile</Text>} />
              <div className={styles.formGroup} style={{ padding: '16px' }}>
                <Field label="Email">
                  <Input
                    type="email"
                    value={formData.email}
                    onChange={(_, data) => setFormData({ ...formData, email: data.value })}
                  />
                </Field>
                <Field label="Notifications">
                  <Switch
                    checked={formData.notifications}
                    onChange={(_, data) => setFormData({ ...formData, notifications: data.checked })}
                  />
                </Field>
              </div>
            </Card>
          </div>
        )

      case 'security':
        return (
          <div>
            <h2 className={styles.sectionTitle}>Security Settings</h2>
            <Card className={styles.card}>
              <CardHeader header={<Text weight="semibold">Authentication</Text>} />
              <div className={styles.formGroup} style={{ padding: '16px' }}>
                <Field label="Two-Factor Authentication">
                  <Switch
                    checked={formData.twoFactorAuth}
                    onChange={(_, data) => setFormData({ ...formData, twoFactorAuth: data.checked })}
                  />
                </Field>
              </div>
            </Card>
          </div>
        )

      case 'database':
        return (
          <div>
            <h2 className={styles.sectionTitle}>Database Settings</h2>
            <Card className={styles.card}>
              <CardHeader header={<Text weight="semibold">Connection</Text>} />
              <div className={styles.formGroup} style={{ padding: '16px' }}>
                <Field label="Database Host">
                  <Input
                    value={formData.dbHost}
                    onChange={(_, data) => setFormData({ ...formData, dbHost: data.value })}
                  />
                </Field>
                <Field label="Database Port">
                  <Input
                    value={formData.dbPort}
                    onChange={(_, data) => setFormData({ ...formData, dbPort: data.value })}
                  />
                </Field>
              </div>
            </Card>
          </div>
        )

      case 'deployments':
        return (
          <div>
            <h2 className={styles.sectionTitle}>Deployment Settings</h2>
            <Card className={styles.card}>
              <CardHeader header={<Text weight="semibold">API Configuration</Text>} />
              <div className={styles.formGroup} style={{ padding: '16px' }}>
                <Field label="API Timeout (seconds)">
                  <Input
                    type="number"
                    value={formData.apiTimeout}
                    onChange={(_, data) => setFormData({ ...formData, apiTimeout: data.value })}
                  />
                </Field>
              </div>
            </Card>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.sidebar}>
        {sections.map((section) => (
          <div
            key={section.id}
            className={`${styles.sidebarItem} ${activeSection === section.id ? styles.sidebarItemActive : ''}`}
            onClick={() => setActiveSection(section.id)}
          >
            {section.icon}
            <span>{section.label}</span>
          </div>
        ))}
      </div>
      <div className={styles.content}>
        {renderSectionContent()}
        <div style={{ marginTop: '24px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <Button appearance="secondary">Cancel</Button>
          <Button appearance="primary" onClick={handleSave}>
            Save Changes
          </Button>
        </div>
      </div>
    </div>
  )
}

