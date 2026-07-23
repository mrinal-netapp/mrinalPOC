import { useState, useCallback, useRef, useEffect } from 'react'
import { makeStyles, tokens, Textarea, Button } from '@fluentui/react-components'
import { Send24Regular, Stop24Regular } from '@fluentui/react-icons'

interface ChatInputProps {
  onSend: (message: string) => void
  onCancel: () => void
  isStreaming: boolean
  disabled: boolean
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    padding: '12px 16px',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  textareaWrapper: {
    flex: 1,
  },
  textarea: {
    width: '100%',
  },
})

const MAX_ROWS = 4

export default function ChatInput({ onSend, onCancel, isStreaming, disabled }: ChatInputProps) {
  const styles = useStyles()
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 22
    const maxHeight = lineHeight * MAX_ROWS
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
  }, [value])

  const handleSend = useCallback(() => {
    const trimmed = value.trim()
    if (!trimmed || isStreaming) return
    onSend(trimmed)
    setValue('')
  }, [value, isStreaming, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div className={styles.container}>
      <div className={styles.textareaWrapper}>
        <Textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="Type a message..."
          value={value}
          onChange={(_e, data) => setValue(data.value)}
          onKeyDown={handleKeyDown}
          resize="none"
          disabled={disabled}
        />
      </div>
      {isStreaming ? (
        <Button
          icon={<Stop24Regular />}
          appearance="subtle"
          onClick={onCancel}
          title="Stop generating"
        />
      ) : (
        <Button
          icon={<Send24Regular />}
          appearance="primary"
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          title="Send message"
        />
      )}
    </div>
  )
}
