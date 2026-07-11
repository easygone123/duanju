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
}

type ConfigMutation = (input: { key: string; value: unknown }) => Promise<unknown>
type ConfigErrorLogger = (message: string, error: unknown) => void

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
    handleUpdateEpisode,
    getProjectStoryboardStats,
  }
}
