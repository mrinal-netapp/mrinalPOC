import { createContext, useContext, useState, ReactNode, ReactElement } from 'react'

export interface Tab {
  id: string
  label: string
  icon?: ReactElement
  type: 'project' | 'deployment' | 'home' | 'settings'
  projectId?: string
  deploymentId?: string
  path: string
}

interface TabContextType {
  tabs: Tab[]
  activeTabId: string | null
  addTab: (tab: Tab) => void
  removeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  getTab: (tabId: string) => Tab | undefined
  findTabByPath: (path: string) => Tab | undefined
}

const TabContext = createContext<TabContextType | undefined>(undefined)

export function TabProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  const addTab = (tab: Tab) => {
    setTabs((prev) => {
      // Check if tab already exists
      const existing = prev.find((t) => t.id === tab.id)
      if (existing) {
        setActiveTabId(tab.id)
        return prev
      }
      setActiveTabId(tab.id)
      return [...prev, tab]
    })
  }

  const removeTab = (tabId: string) => {
    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId)
      // If removing active tab, activate the last remaining tab or home
      if (activeTabId === tabId) {
        if (newTabs.length > 0) {
          setActiveTabId(newTabs[newTabs.length - 1].id)
        } else {
          setActiveTabId(null)
        }
      }
      return newTabs
    })
  }

  const setActiveTab = (tabId: string) => {
    setActiveTabId(tabId)
  }

  const getTab = (tabId: string) => {
    return tabs.find((t) => t.id === tabId)
  }

  const findTabByPath = (path: string) => {
    return tabs.find((t) => t.path === path)
  }

  return (
    <TabContext.Provider
      value={{
        tabs,
        activeTabId,
        addTab,
        removeTab,
        setActiveTab,
        getTab,
        findTabByPath,
      }}
    >
      {children}
    </TabContext.Provider>
  )
}

export function useTabs() {
  const context = useContext(TabContext)
  if (context === undefined) {
    throw new Error('useTabs must be used within a TabProvider')
  }
  return context
}

