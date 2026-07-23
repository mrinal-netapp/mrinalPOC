import React from 'react'
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Button,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import { Dismiss24Regular } from '@fluentui/react-icons'

export interface WizardStep {
  number: number
  title: string
  description: string
}

export interface WizardModalProps {
  title: string
  children: React.ReactNode
  onClose: () => void
  onSubmit: () => void
  submitting: boolean
  formError: string | null
  currentStep: number
  onNext: () => void
  onPrev: () => void
  steps: WizardStep[]
  submitLabel?: string
  mode?: 'create' | 'edit'
  onStepClick?: (stepNumber: number) => void
  /** Shown under the primary action while submitting (e.g. post-upload server work) */
  submittingHint?: string | null
  /** If provided, shows an "Abort Upload" button during submission instead of disabling Cancel */
  onAbort?: () => void
}

export function WizardModal({
  title,
  children,
  onClose,
  onSubmit,
  submitting,
  formError,
  currentStep,
  onNext,
  onPrev,
  steps,
  submitLabel = 'Create',
  mode = 'create',
  onStepClick,
  submittingHint = null,
  onAbort,
}: WizardModalProps) {
  const isLastStep = currentStep === steps.length
  const progressPercentage = ((currentStep - 1) / (steps.length - 1)) * 100

  return (
    <Dialog open={true} onOpenChange={(_, data) => !data.open && !submitting && onClose()}>
      <DialogSurface style={{ maxWidth: '1200px', width: '95vw' }}>
        <DialogTitle>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span>{title}</span>
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              disabled={submitting}
              aria-label="Close"
            />
          </div>
        </DialogTitle>

        <DialogBody>
          {/* Modern Wizard Progress Indicator */}
          <div style={{ 
            padding: '32px 24px', 
            backgroundColor: 'var(--colorNeutralBackground1)',
            borderBottom: '1px solid var(--colorNeutralStroke2)',
            gridColumn: '1 / -1',
          }}>
              {/* Progress bar container */}
              <div style={{ 
                position: 'relative',
                height: '4px',
                backgroundColor: 'var(--colorNeutralStroke2)',
                borderRadius: '2px',
                overflow: 'hidden',
                marginBottom: '32px'
              }}>
                {/* Progress fill */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    height: '100%',
                    width: `${progressPercentage}%`,
                    backgroundColor: 'var(--colorBrandBackground)',
                    borderRadius: '2px',
                    transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  }}
                />
              </div>

              {/* Step indicators */}
              <div style={{ 
                display: 'grid',
                gridTemplateColumns: `repeat(${steps.length}, 1fr)`,
                position: 'relative',
              }}>
                {steps.map((step) => {
                  const isCompleted = currentStep > step.number
                  const isCurrent = currentStep === step.number
                  const isClickable = onStepClick && !submitting && !isCurrent && (
                    mode === 'edit' || isCompleted
                  )
                  
                  return (
                    <div
                      key={step.number}
                      onClick={isClickable ? () => onStepClick(step.number) : undefined}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        position: 'relative',
                        zIndex: 2,
                        minWidth: 0,
                        cursor: isClickable ? 'pointer' : 'default',
                      }}
                    >
                      {/* Step circle */}
                      <div
                        style={{
                          width: '48px',
                          height: '48px',
                          borderRadius: '50%',
                          backgroundColor: isCompleted || isCurrent
                            ? 'var(--colorBrandBackground)'
                            : 'var(--colorNeutralBackground3)',
                          border: `3px solid ${
                            isCompleted || isCurrent
                              ? 'var(--colorBrandBackground)'
                              : 'var(--colorNeutralStroke2)'
                          }`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 600,
                          fontSize: '16px',
                          color: isCompleted || isCurrent ? 'white' : 'var(--colorNeutralForeground3)',
                          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                          boxShadow: isCurrent 
                            ? '0 0 0 6px rgba(99, 102, 241, 0.12), 0 2px 8px rgba(0, 0, 0, 0.1)' 
                            : isCompleted
                            ? '0 2px 4px rgba(0, 0, 0, 0.1)'
                            : 'none',
                          position: 'relative',
                          zIndex: 3,
                          flexShrink: 0,
                          marginBottom: '12px',
                        }}
                      >
                        {isCompleted ? (
                          <svg
                            width="20"
                            height="20"
                            viewBox="0 0 20 20"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M16.7071 5.29289C17.0976 5.68342 17.0976 6.31658 16.7071 6.70711L8.70711 14.7071C8.31658 15.0976 7.68342 15.0976 7.29289 14.7071L3.29289 10.7071C2.90237 10.3166 2.90237 9.68342 3.29289 9.29289C3.68342 8.90237 4.31658 8.90237 4.70711 9.29289L8 12.5858L15.2929 5.29289C15.6834 4.90237 16.3166 4.90237 16.7071 5.29289Z"
                              fill="currentColor"
                            />
                          </svg>
                        ) : (
                          step.number
                        )}
                      </div>

                      {/* Step label */}
                      <div style={{ 
                        textAlign: 'center', 
                        padding: '0 4px',
                        overflow: 'hidden',
                      }}>
                        <div style={{ 
                          fontSize: '13px', 
                          fontWeight: isCurrent ? 600 : 500,
                          color: isCurrent || isCompleted
                            ? 'var(--colorNeutralForeground1)'
                            : 'var(--colorNeutralForeground3)',
                          marginBottom: '4px',
                          transition: 'all 0.2s ease',
                        }}>
                          {step.title}
                        </div>
                        <div style={{ 
                          fontSize: '11px', 
                          color: 'var(--colorNeutralForeground3)',
                          lineHeight: '1.4'
                        }}>
                          {step.description}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Step counter */}
              <div style={{
                textAlign: 'center',
                marginTop: '16px',
                fontSize: '12px',
                color: 'var(--colorNeutralForeground3)',
                fontWeight: 500
              }}>
                Step {currentStep} of {steps.length}
              </div>
          </div>

          {/* Wizard Content */}
          <DialogContent style={{ 
            minHeight: '400px', 
            maxHeight: '65vh', 
            overflowY: 'auto', 
            padding: '32px',
            paddingBottom: '48px',
          }}>
            {formError && (
              <MessageBar intent="error" style={{ marginBottom: '20px' }}>
                <MessageBarBody>{formError}</MessageBarBody>
              </MessageBar>
            )}
            {children}
          </DialogContent>

          {/* Wizard Footer: one button row (aligned); hint below so Cancel/Previous aren’t centered against tall content */}
          <DialogActions style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                width: '100%',
                padding: '16px 24px',
                borderTop: '1px solid var(--colorNeutralStroke2)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {submitting && onAbort ? (
                  <Button
                    appearance="subtle"
                    onClick={onAbort}
                    style={{ color: 'var(--colorPaletteRedForeground1)' }}
                  >
                    Abort Upload
                  </Button>
                ) : (
                  <Button appearance="secondary" onClick={onClose} disabled={submitting}>
                    Cancel
                  </Button>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px', marginLeft: 'auto' }}>
                {currentStep > 1 && (
                  <Button appearance="secondary" onClick={onPrev} disabled={submitting} type="button">
                    Previous
                  </Button>
                )}
                {!isLastStep ? (
                  <Button appearance="primary" onClick={onNext} disabled={submitting} type="button">
                    Next
                  </Button>
                ) : (
                  <Button appearance="primary" onClick={onSubmit} disabled={submitting} type="button">
                    {submitting
                      ? mode === 'edit'
                        ? 'Updating...'
                        : 'Creating...'
                      : mode === 'edit'
                        ? 'Update'
                        : submitLabel}
                  </Button>
                )}
              </div>
            </div>
            {submitting && submittingHint && (
              <div
                style={{
                  padding: '0 24px 16px',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  color: 'var(--colorNeutralForeground3)',
                  textAlign: 'right',
                  borderTop: '1px solid var(--colorNeutralStroke2)',
                }}
              >
                {submittingHint}
              </div>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
