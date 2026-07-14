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
  const didCloseWhileInactiveRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!isOpen) {
      didCloseWhileInactiveRef.current = false
      return
    }

    if (!isStageActive && !didCloseWhileInactiveRef.current) {
      didCloseWhileInactiveRef.current = true
      onCloseRef.current()
    }
  }, [isOpen, isStageActive])

  return isStageActive
}
