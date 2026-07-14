'use client'

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

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

export function useCloseOnWorkspaceStageInactive(isOpen: boolean, onClose: () => void) {
  const isStageActive = useWorkspaceStageActivity()
  const wasStageActiveRef = useRef(isStageActive)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const wasStageActive = wasStageActiveRef.current
    wasStageActiveRef.current = isStageActive
    if (wasStageActive && !isStageActive && isOpen) onCloseRef.current()
  }, [isOpen, isStageActive])

  return isStageActive
}
