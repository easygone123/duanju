'use client'

import { useEpisodeStageData } from '@/lib/query/hooks/useEpisodeStageData'
import type { EpisodeStage } from '@/lib/novel-promotion/episode-stage-data'
import type { NovelPromotionClip, NovelPromotionStoryboard } from '@/types/project'
import { useWorkspaceProvider } from '../WorkspaceProvider'

export function useWorkspaceEpisodeStageData(stage: EpisodeStage) {
  const { projectId, episodeId } = useWorkspaceProvider()
  const query = useEpisodeStageData(projectId, episodeId || null, stage)
  const episode = query.data?.episode
  const clips = episode && 'clips' in episode
    ? episode.clips as NovelPromotionClip[]
    : []
  const storyboards = episode && 'storyboards' in episode
    ? episode.storyboards as unknown as NovelPromotionStoryboard[]
    : []

  return {
    ...query,
    episodeName: episode?.name,
    novelText: episode && 'novelText' in episode ? episode.novelText || '' : '',
    clips,
    storyboards,
  }
}
