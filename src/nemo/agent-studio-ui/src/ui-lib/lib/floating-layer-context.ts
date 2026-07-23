import { createContext, useContext } from "react"

// Must match --zindex-floating-layer in variables.scss
const DEFAULT_Z_INDEX = 50

interface FloatingLayerContextValue {
  zIndex: number
}

const FloatingLayerContext = createContext<FloatingLayerContextValue>({
  zIndex: DEFAULT_Z_INDEX,
})

function useFloatingLayerZIndex(): number {
  return useContext(FloatingLayerContext).zIndex
}

export { FloatingLayerContext, useFloatingLayerZIndex, DEFAULT_Z_INDEX }
