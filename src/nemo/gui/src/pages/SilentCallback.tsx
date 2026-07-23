import { useEffect } from 'react'
import { handleSilentCallback } from '../contexts/AuthContext'

// Silent callback page - used for token refresh
// This page should be loaded in a hidden iframe
const SilentCallback = () => {
  useEffect(() => {
    handleSilentCallback().catch((error) => {
      console.error('Silent callback failed:', error)
    })
  }, [])

  return null // This page should be invisible
}

export default SilentCallback
