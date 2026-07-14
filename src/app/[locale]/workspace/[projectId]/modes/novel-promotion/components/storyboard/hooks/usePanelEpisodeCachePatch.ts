'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { NovelPromotionStoryboard } from '@/types/project'
import { queryKeys } from '@/lib/query/keys'

type EpisodeDataCache = Record<string, unknown> & {
  storyboards?: NovelPromotionStoryboard[]
}

function isEpisodeDataCache(value: unknown): value is EpisodeDataCache {
  return typeof value === 'object' && value !== null
}

function patchPanelInEpisodeCache(
  previous: unknown,
  panelId: string,
  updates: Record<string, unknown>,
) {
  if (!isEpisodeDataCache(previous)) return previous
  const nestedEpisode = isEpisodeDataCache(previous.episode) ? previous.episode : null
  const container = nestedEpisode ?? previous
  if (!Array.isArray(container.storyboards)) return previous

  let changed = false
  const storyboards = container.storyboards.map((storyboard) => {
    const panels = Array.isArray(storyboard?.panels) ? storyboard.panels : []
    let panelChanged = false
    const nextPanels = panels.map((panel) => {
      if (panel?.id !== panelId) return panel
      panelChanged = true
      changed = true
      return { ...panel, ...updates }
    })

    return panelChanged ? { ...storyboard, panels: nextPanels } : storyboard
  })

  if (!changed) return previous
  if (nestedEpisode) {
    return { ...previous, episode: { ...nestedEpisode, storyboards } }
  }
  return { ...previous, storyboards }
}

interface UsePanelEpisodeCachePatchParams {
  projectId: string
  episodeId?: string
}

export function usePanelEpisodeCachePatch({
  projectId,
  episodeId,
}: UsePanelEpisodeCachePatchParams) {
  const queryClient = useQueryClient()

  return useCallback((panelId: string, updates: Record<string, unknown>) => {
    if (!episodeId) return
    const patch = (previous: unknown) => patchPanelInEpisodeCache(previous, panelId, updates)
    queryClient.setQueryData(queryKeys.episodeStage(projectId, episodeId, 'storyboard'), patch)
    queryClient.setQueryData(queryKeys.episodeData(projectId, episodeId), patch)
  }, [episodeId, projectId, queryClient])
}
