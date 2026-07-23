/**
 * Panel state interface
 */
export interface PanelState {
  panelWidth: number
  setPanelWidth: (width: number) => void
  selectedBlockId: string | null
  setSelectedBlockId: (blockId: string | null) => void
  _hasHydrated: boolean
  setHasHydrated: (hasHydrated: boolean) => void
}

