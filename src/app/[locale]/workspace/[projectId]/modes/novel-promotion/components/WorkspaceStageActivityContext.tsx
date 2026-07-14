'use client'

import { createContext, useContext, type ReactNode } from 'react'

const WorkspaceStageActivityContext = createContext(true)

export function WorkspaceStageActivityProvider({
  isActive,
  children,
}: {
  isActive: boolean
  children: ReactNode
}) {
  return (
    <WorkspaceStageActivityContext.Provider value={isActive}>
      {children}
    </WorkspaceStageActivityContext.Provider>
  )
}

export function useWorkspaceStageActivity() {
  return useContext(WorkspaceStageActivityContext)
}
