import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PanelState } from './types'

/**
 * Panel width constraints
 * Note: Maximum width is enforced dynamically at 40% of viewport width in the resize hook
 */
const MIN_PANEL_WIDTH = 244

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      panelWidth: MIN_PANEL_WIDTH,
      setPanelWidth: (width) => {
        // Only enforce minimum - maximum is enforced dynamically by the resize hook
        const clampedWidth = Math.max(MIN_PANEL_WIDTH, width)
        set({ panelWidth: clampedWidth })
        // Update CSS variable for immediate visual feedback
        if (typeof window !== 'undefined') {
          document.documentElement.style.setProperty('--panel-width', `${clampedWidth}px`)
        }
      },
      selectedBlockId: null,
      setSelectedBlockId: (blockId) => {
        set({ selectedBlockId: blockId })
      },
      _hasHydrated: false,
      setHasHydrated: (hasHydrated) => {
        set({ _hasHydrated: hasHydrated })
      },
    }),
    {
      name: 'panel-state',
      // Only persist panelWidth, not selectedBlockId or _hasHydrated
      partialize: (state) => ({
        panelWidth: state.panelWidth,
      }),
      onRehydrateStorage: () => (state) => {
        // Sync CSS variables with stored state after rehydration
        if (state && typeof window !== 'undefined') {
          document.documentElement.style.setProperty('--panel-width', `${state.panelWidth}px`)
        }
        // Mark as hydrated after rehydration completes
        if (state) {
          state.setHasHydrated(true)
        }
      },
    }
  )
)

