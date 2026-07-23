import React, { createContext, useContext, useState, useCallback } from 'react'
import { ToastContainer } from '../components/toast/ToastContainer'

export interface Toast {
  id: string
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  duration?: number
}

interface ToastContextType {
  showToast: (message: string, type?: 'success' | 'error' | 'info' | 'warning', duration?: number) => void
}

const ToastContext = createContext<ToastContextType | undefined>(undefined)

export const useToast = () => {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within ToastProvider')
  }
  return context
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' | 'warning' = 'success', duration: number = 3000) => {
    const id = `toast-${Date.now()}-${Math.random()}`
    setToasts((prev) => [...prev, { id, message, type, duration }])
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer 
        toasts={toasts.map(toast => ({ 
          id: toast.id,
          message: toast.message,
          type: toast.type,
          duration: toast.duration,
          onDismiss: dismissToast
        }))} 
        onDismiss={dismissToast} 
      />
    </ToastContext.Provider>
  )
}

