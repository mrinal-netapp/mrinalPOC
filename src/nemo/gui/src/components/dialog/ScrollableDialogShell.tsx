import { ReactNode } from 'react'
import type { CSSProperties } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components'

/**
 * Shared dialog shell for explorer-style modals (tree browsers, path pickers).
 *
 * Layout contract — pinned once here so individual call sites don't drift:
 *   1. The DialogSurface is the viewport: flex column, capped at min(85vh, 900px).
 *   2. The body slot is the ONLY scroll region.
 *   3. Title (header) + actions (footer) stay non-scrolling, always visible.
 *
 * Anything passed into `body` should NOT add its own `overflow: auto` — the
 * shell already owns that. Headers/footers may add internal flex layouts but
 * should not introduce vertical scroll.
 */

const useStyles = makeStyles({
  surface: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    padding: 0,
    boxSizing: 'border-box',
  },
  surfaceResizable: {
    resize: 'both',
  },
  /**
   * Flex column — NOT Fluent's default DialogBody grid — so `DialogActions` is
   * a direct child and stays in the bottom row. Nesting `DialogActions` inside
   * another element breaks `grid-area: actions` and can pin the Close button
   * to the top-right.
   */
  dialogBody: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    width: '100%',
  },
  titleSlot: {
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalS}`,
    margin: 0,
  },
  bodySlot: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
    padding: `0 ${tokens.spacingHorizontalL}`,
    display: 'flex',
    flexDirection: 'column',
  },
  bodySlotPadded: {
    padding: tokens.spacingHorizontalL,
  },
  bodySlotFlush: {
    padding: 0,
  },
  /** Fills the dialog content slot so nested `height: 100%` split layouts work. */
  bodyInner: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  footerAboveActions: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  actionsRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
    margin: 0,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
})

export interface ScrollableDialogShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  /** The primary content area — the only scrolling region. */
  body: ReactNode
  /** Optional non-scrolling region above the actions (e.g. selection summary). */
  footer?: ReactNode
  /** Right-aligned action buttons (Cancel / Confirm). */
  actions: ReactNode
  /** Surface max width. Defaults to `min(960px, 95vw)`. */
  maxWidth?: string
  /** Surface max height. Defaults to `min(85vh, 900px)`. */
  maxHeight?: string
  /** Initial width — used when resizable. Defaults to `min(960px, 95vw)`. */
  initialWidth?: string
  /** Initial height — used when resizable. Defaults to `min(80vh, 800px)`. */
  initialHeight?: string
  /** Minimum width (px or CSS string). Defaults to 480. */
  minWidth?: number | string
  /** Minimum height (px or CSS string). Defaults to 360. */
  minHeight?: number | string
  /**
   * When true, the surface gets a native CSS resize handle (bottom-right).
   * Combined with min/max sizing it gives users fluent resize without dragging
   * a bespoke handle.
   */
  resizable?: boolean
  /**
   * `padded` (default): comfortable horizontal padding around the body.
   * `flush`: zero body padding — useful when body owns its own borders/header.
   */
  bodyPadding?: 'padded' | 'flush'
  /** modalType override; defaults to Fluent default (modal). */
  modalType?: 'modal' | 'non-modal' | 'alert'
}

export function ScrollableDialogShell({
  open,
  onOpenChange,
  title,
  body,
  footer,
  actions,
  maxWidth,
  maxHeight,
  initialWidth,
  initialHeight,
  minWidth,
  minHeight,
  resizable = false,
  bodyPadding = 'padded',
  modalType,
}: ScrollableDialogShellProps) {
  const styles = useStyles()
  const px = (v: number | string | undefined) =>
    v === undefined ? undefined : typeof v === 'number' ? `${v}px` : v
  const surfaceStyle: CSSProperties = resizable
    ? {
        width: initialWidth || 'min(960px, 95vw)',
        height: initialHeight || 'min(80vh, 800px)',
        maxWidth: maxWidth || '98vw',
        maxHeight: maxHeight || '95vh',
        minWidth: px(minWidth ?? 480),
        minHeight: px(minHeight ?? 360),
      }
    : {
        width: '100%',
        maxWidth: maxWidth || 'min(960px, 95vw)',
        maxHeight: maxHeight || 'min(85vh, 900px)',
        ...(minWidth !== undefined ? { minWidth: px(minWidth) } : {}),
        ...(minHeight !== undefined ? { minHeight: px(minHeight) } : {}),
      }

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => onOpenChange(data.open)}
      modalType={modalType}
    >
      <DialogSurface
        className={mergeClasses(styles.surface, resizable && styles.surfaceResizable)}
        style={surfaceStyle}
      >
        <DialogBody className={styles.dialogBody}>
          <DialogTitle className={styles.titleSlot}>{title}</DialogTitle>
          <DialogContent
            className={mergeClasses(
              styles.bodySlot,
              bodyPadding === 'padded' ? styles.bodySlotPadded : styles.bodySlotFlush,
            )}
          >
            <div className={styles.bodyInner}>{body}</div>
          </DialogContent>
          {footer ? <div className={styles.footerAboveActions}>{footer}</div> : null}
          <DialogActions className={styles.actionsRow}>{actions}</DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}
