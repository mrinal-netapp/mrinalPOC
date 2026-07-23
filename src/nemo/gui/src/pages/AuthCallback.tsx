import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { handleAuthCallback } from '../contexts/AuthContext'
import { Spinner, Text } from '@fluentui/react-components'

const AuthCallback = () => {
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const processCallback = async () => {
      try {
        await handleAuthCallback()
        // Redirect will happen in handleAuthCallback
      } catch (err) {
        console.error('Auth callback processing failed:', err)
        setError(err instanceof Error ? err.message : 'Authentication failed')
        // Redirect to login after a delay
        setTimeout(() => {
          navigate('/login')
        }, 3000)
      }
    }

    processCallback()
  }, [navigate])

  if (error) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        flexDirection: 'column',
        gap: '1rem'
      }}>
        <Text as="h2" size={600}>Authentication Error</Text>
        <Text>{error}</Text>
        <Text>Redirecting to login...</Text>
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      flexDirection: 'column',
      gap: '1rem'
    }}>
      <Spinner label="Completing sign in..." />
    </div>
  )
}

export default AuthCallback
