'use client'

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { resolveTaskErrorMessage } from '@/lib/task/error-message'
import type {
  EpisodeStage,
  EpisodeStagePayload,
  EpisodeStagePayloadByStage,
} from '@/lib/novel-promotion/episode-stage-data'
import { queryKeys } from '../keys'

export type {
  ConfigEpisodeStagePayload,
  EpisodeStage,
  EpisodeStagePayload,
  EpisodeStagePayloadByStage,
} from '@/lib/novel-promotion/episode-stage-data'

export function episodeStageQueryOptions<S extends EpisodeStage>(
  projectId: string | null,
  episodeId: string | null,
  stage: S,
  cursor?: string,
) {
  const enabled = !!projectId && !!episodeId
  return {
    queryKey: queryKeys.episodeStage(projectId || '', episodeId || '', stage, cursor),
    queryFn: async (): Promise<EpisodeStagePayloadByStage[S]> => {
      if (!projectId || !episodeId) {
        throw new Error('Project ID and Episode ID are required')
      }
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const response = await apiFetch(
        `/api/novel-promotion/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/stage/${encodeURIComponent(stage)}${query}`,
      )
      if (!response.ok) {
        const error = await response.json()
        throw new Error(resolveTaskErrorMessage(error, 'Failed to load episode stage'))
      }
      const payload = await response.json() as EpisodeStagePayload
      if (payload.stage !== stage) {
        throw new Error(`Episode stage response mismatch: expected ${stage}, received ${payload.stage}`)
      }
      return payload as EpisodeStagePayloadByStage[S]
    },
    enabled,
    staleTime: 5000,
  }
}

export function useEpisodeStageData<S extends EpisodeStage>(
  projectId: string | null,
  episodeId: string | null,
  stage: S,
  cursor?: string,
) {
  return useQuery(episodeStageQueryOptions(projectId, episodeId, stage, cursor))
}
