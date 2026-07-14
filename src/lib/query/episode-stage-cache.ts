import type { QueryClient } from '@tanstack/react-query'
import { queryKeys } from './keys'

/**
 * Coarse Task 3 invalidation. Project-only callers invalidate every stage
 * projection; episode-aware callers also preserve the legacy full response
 * invalidation for non-workspace consumers.
 */
export async function invalidateEpisodeStageQueries(
  queryClient: QueryClient,
  projectId: string,
  episodeId?: string,
) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: queryKeys.episodeStages(projectId, episodeId) }),
  ]
  if (episodeId) {
    invalidations.push(
      queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) }),
    )
  }
  await Promise.all(invalidations)
}
