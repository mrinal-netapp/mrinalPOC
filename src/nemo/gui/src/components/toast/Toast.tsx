import React, { useEffect } from 'react'
import { MessageBar, MessageBarBody } from '@fluentui/react-components'
import { Dismiss24Regular } from '@fluentui/react-icons'
import { Button } from '@fluentui/react-components'

export interface ToastProps {
  id: string
  message: string
  type?: 'success' | 'error' | 'info' | 'warning'
  duration?: number
  onDismiss: (id: string) => void
}

export const Toast: React.FC<ToastProps> = ({ id, message, type = 'success', duration = 3000, onDismiss }) => {
  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => {
        onDismiss(id)
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [id, duration, onDismiss])

  const intent = type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : 'success'

  return (
    <div
      style={{
        marginBottom: '8px',
        animation: 'slideIn 0.3s ease-out',
      }}
    >
      <MessageBar intent={intent} style={{ position: 'relative', minWidth: '300px', maxWidth: '500px' }}>
        <MessageBarBody>{message}</MessageBarBody>
        <Button
          appearance="subtle"
          icon={<Dismiss24Regular />}
          onClick={() => onDismiss(id)}
          style={{ position: 'absolute', top: '8px', right: '8px', minWidth: 'auto', padding: '4px' }}
          title="Dismiss"
        />
      </MessageBar>
      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  )
}


