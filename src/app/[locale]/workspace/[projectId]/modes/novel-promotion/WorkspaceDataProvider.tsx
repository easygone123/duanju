'use client'

import React, { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useProjectAssets, type ProjectAssetsData } from '@/lib/query/hooks/useProjectAssets'
import {
  selectImageModelOptions,
  useUserModels,
  type UserModelOption,
  type UserModelsPayload,
} from '@/lib/query/hooks/useUserModels'

interface WorkspaceDataContextValue {
  projectAssets: ProjectAssetsData
  projectAssetsLoading: boolean
  projectAssetsError: Error | null
  userModels: UserModelsPayload | null
  imageModelOptions: UserModelOption[]
  videoModelOptions: UserModelOption[]
  upscaleModelOptions: UserModelOption[]
  userModelsLoaded: boolean
  userModelsError: Error | null
}

const WorkspaceDataContext = createContext<WorkspaceDataContextValue | null>(null)

export function WorkspaceDataProvider({
  projectId,
  children,
}: {
  projectId: string
  children: ReactNode
}) {
  const projectAssetsQuery = useProjectAssets(projectId)
  const userModelsQuery = useUserModels()
  const projectAssets = projectAssetsQuery.data
  const userModels = userModelsQuery.data ?? null
  const imageModelOptions = useMemo(
    () => selectImageModelOptions(userModelsQuery.data),
    [userModelsQuery.data],
  )
  const videoModelOptions = useMemo(() => userModels?.video ?? [], [userModels])
  const upscaleModelOptions = useMemo(() => userModels?.upscale ?? [], [userModels])

  const value = useMemo<WorkspaceDataContextValue>(() => ({
    projectAssets,
    projectAssetsLoading: projectAssetsQuery.isLoading,
    projectAssetsError: projectAssetsQuery.error instanceof Error ? projectAssetsQuery.error : null,
    userModels,
    imageModelOptions,
    videoModelOptions,
    upscaleModelOptions,
    userModelsLoaded: userModelsQuery.isFetched,
    userModelsError: userModelsQuery.error instanceof Error ? userModelsQuery.error : null,
  }), [
    imageModelOptions,
    projectAssets,
    projectAssetsQuery.error,
    projectAssetsQuery.isLoading,
    upscaleModelOptions,
    userModels,
    userModelsQuery.error,
    userModelsQuery.isFetched,
    videoModelOptions,
  ])

  return <WorkspaceDataContext.Provider value={value}>{children}</WorkspaceDataContext.Provider>
}

export function useWorkspaceData() {
  const context = useContext(WorkspaceDataContext)
  if (!context) throw new Error('useWorkspaceData must be used within WorkspaceDataProvider')
  return context
}
