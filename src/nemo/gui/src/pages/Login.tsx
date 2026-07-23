import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useSetupStatus } from '../hooks/useSetupStatus'
import { Button, Spinner, Text } from '@fluentui/react-components'

const Login = () => {
  const { login, isAuthenticated, isLoading } = useAuth()
  const { isLoading: isSetupLoading, isSetupComplete } = useSetupStatus()
  const navigate = useNavigate()

  useEffect(() => {
    // If already authenticated, redirect to home
    if (isAuthenticated) {
      navigate('/')
    }
  }, [isAuthenticated, navigate])

  useEffect(() => {
    // Check setup status and redirect to setup page if not complete
    // Only redirect if we're not already on the setup page and not currently loading
    const currentPath = window.location.pathname;
    const basePath = import.meta.env.VITE_BASE_PATH || '';
    const normalizedPath = currentPath.replace(basePath, '') || '/';
    
    if (!isSetupLoading && !isSetupComplete && normalizedPath !== '/setup' && normalizedPath !== '/setup/') {
      navigate('/setup', { replace: true });
    }
  }, [isSetupLoading, isSetupComplete, navigate])

  const handleLogin = async () => {
    try {
      await login()
    } catch (error) {
      console.error('Login failed:', error)
    }
  }

  if (isLoading || isSetupLoading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        minHeight: '100vh',
        flexDirection: 'column',
        gap: '1rem'
      }}>
        <Spinner label="Loading..." />
      </div>
    )
  }

  // Don't show login if setup is not complete (will redirect to /setup)
  if (!isSetupComplete) {
    return null
  }

  if (isAuthenticated) {
    return null // Will redirect via useEffect
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      flexDirection: 'column',
      gap: '2rem',
      padding: '2rem'
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        alignItems: 'center',
        maxWidth: '400px',
        textAlign: 'center'
      }}>
        <Text as="h1" size={700} weight="semibold">
          Welcome to AgentStudio
        </Text>
        <Text>
          Please sign in to continue
        </Text>
        <Button 
          appearance="primary" 
          size="large"
          onClick={handleLogin}
          style={{ marginTop: '1rem' }}
        >
          Sign In
        </Button>
      </div>
    </div>
  )
}

export default Login
