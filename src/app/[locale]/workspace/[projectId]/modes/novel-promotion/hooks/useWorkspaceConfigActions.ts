'use client'

import { logError as _ulogError } from '@/lib/logging/core'
import { useCallback } from 'react'
import {
  useGetProjectStoryboardStats,
  useUpdateProjectConfig,
  useUpdateProjectEpisodeField,
} from '@/lib/query/hooks'

interface UseWorkspaceConfigActionsParams {
  projectId: string
  episodeId?: string
  onStageChange?: (stage: string) => void
  onRefresh: (options?: { scope?: string; mode?: string }) => Promise<void>
}

type ConfigMutation = (input: { key: string; value: unknown }) => Promise<unknown>
type ConfigErrorLogger = (message: string, error: unknown) => void

export const STORYBOARD_CONFIG_KEYS = [
  'storyboardGenerationMode',
  'sixGridCellAspectRatio',
  'sixGridProcessingOrder',
  'storyboardUpscaleModel',
  'dialogueVideoModel',
] as const
export type StoryboardConfigKey = typeof STORYBOARD_CONFIG_KEYS[number]

export function createStoryboardConfigUpdater(input: {
  mutateAsync: ConfigMutation
  refresh: () => Promise<unknown>
  reportError: ConfigErrorLogger
}) {
  return async (key: StoryboardConfigKey, value: unknown): Promise<boolean> => {
    try {
      await input.mutateAsync({ key, value })
      return true
    } catch (error) {
      input.reportError('Update storyboard config error:', error)
      try {
        await input.refresh()
      } catch (refreshError) {
        input.reportError('Refresh storyboard config after failure error:', refreshError)
      }
      return false
    }
  }
}

export function createWorkspaceConfigHandlers(
  mutateAsync: ConfigMutation,
  logError: ConfigErrorLogger,
) {
  const handleUpdateConfigStrict = async (key: string, value: unknown): Promise<void> => {
    await mutateAsync({ key, value })
  }
  const handleUpdateConfig = async (key: string, value: unknown): Promise<void> => {
    try {
      await handleUpdateConfigStrict(key, value)
    } catch (error: unknown) {
      logError('Update config error:', error)
    }
  }
  return { handleUpdateConfig, handleUpdateConfigStrict }
}

export function useWorkspaceConfigActions({
  projectId,
  episodeId,
  onStageChange,
  onRefresh,
}: UseWorkspaceConfigActionsParams) {
  const updateProjectConfigMutation = useUpdateProjectConfig(projectId)
  const updateProjectEpisodeMutation = useUpdateProjectEpisodeField(projectId)
  const getProjectStoryboardStatsMutation = useGetProjectStoryboardStats(projectId)

  const handleStageChange = useCallback((stage: string) => {
    onStageChange?.(stage)
  }, [onStageChange])

  const handleUpdateConfigStrict = useCallback(async (key: string, value: unknown) => {
    const handlers = createWorkspaceConfigHandlers(
      updateProjectConfigMutation.mutateAsync,
      _ulogError,
    )
    await handlers.handleUpdateConfigStrict(key, value)
  }, [updateProjectConfigMutation])

  const handleUpdateConfig = useCallback(async (key: string, value: unknown) => {
    const handlers = createWorkspaceConfigHandlers(
      updateProjectConfigMutation.mutateAsync,
      _ulogError,
    )
    await handlers.handleUpdateConfig(key, value)
  }, [updateProjectConfigMutation])

  const handleUpdateStoryboardConfig = useCallback(async (
    key: StoryboardConfigKey,
    value: unknown,
  ) => {
    const update = createStoryboardConfigUpdater({
      mutateAsync: updateProjectConfigMutation.mutateAsync,
      refresh: () => onRefresh({ scope: 'project' }),
      reportError: _ulogError,
    })
    return update(key, value)
  }, [onRefresh, updateProjectConfigMutation.mutateAsync])

  const handleUpdateEpisode = useCallback(async (key: string, value: unknown) => {
    if (!episodeId) {
      _ulogError('No episode selected')
      return
    }

    try {
      await updateProjectEpisodeMutation.mutateAsync({ episodeId, key, value })
    } catch (error: unknown) {
      _ulogError('Update episode error:', error)
    }
  }, [episodeId, updateProjectEpisodeMutation])

  const getProjectStoryboardStats = useCallback(async (targetEpisodeId: string) => {
    return getProjectStoryboardStatsMutation.mutateAsync({ episodeId: targetEpisodeId })
  }, [getProjectStoryboardStatsMutation])

  return {
    handleStageChange,
    handleUpdateConfig,
    handleUpdateConfigStrict,
    handleUpdateStoryboardConfig,
    handleUpdateEpisode,
    getProjectStoryboardStats,
  }
}
