'use client'

import { useMemo } from 'react'
import type { NovelPromotionStoryboard } from '@/types/project'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'

interface TaskTarget {
  key: string
  targetType: string
  targetId: string
  types: string[]
  resource: 'text' | 'image' | 'video'
  hasOutput: boolean
}

interface UseStoryboardTaskAwareStoryboardsProps {
  projectId: string
  initialStoryboards: NovelPromotionStoryboard[]
  isRunningPhase: (phase: string | null | undefined) => boolean
}

export function buildStoryboardTaskTypeContract() {
  return {
    text: ['regenerate_storyboard_text', 'insert_panel'],
    grid: ['storyboard_sheet_generate', 'storyboard_sheet_upscale', 'storyboard_sheet_crop'],
    panel: ['storyboard_panel_upscale'],
  }
}

export function buildSixGridTaskTypeContract() {
  const contract = buildStoryboardTaskTypeContract()
  return {
    storyboard: contract.grid,
    panel: contract.panel,
  }
}

function buildStoryboardTextTargets(storyboards: NovelPromotionStoryboard[]): TaskTarget[] {
  const targets: TaskTarget[] = []
  const episodeTargets = new Map<string, TaskTarget>()
  const textTypes = buildStoryboardTaskTypeContract().text

  for (const storyboard of storyboards) {
    const hasOutput = !!(storyboard.panels || []).length
    targets.push({
      key: `storyboard-text:${storyboard.id}`,
      targetType: 'NovelPromotionStoryboard',
      targetId: storyboard.id,
      types: textTypes,
      resource: 'text',
      hasOutput,
    })
    if (storyboard.episodeId) {
      const existingEpisodeTarget = episodeTargets.get(storyboard.episodeId)
      if (existingEpisodeTarget) {
        existingEpisodeTarget.hasOutput ||= hasOutput
        continue
      }
      const episodeTarget: TaskTarget = {
        key: `episode-text:${storyboard.episodeId}`,
        targetType: 'NovelPromotionEpisode',
        targetId: storyboard.episodeId,
        types: textTypes,
        resource: 'text',
        hasOutput,
      }
      episodeTargets.set(storyboard.episodeId, episodeTarget)
      targets.push(episodeTarget)
    }
  }

  return targets
}

function buildStoryboardGridTargets(storyboards: NovelPromotionStoryboard[]): TaskTarget[] {
  const gridTypes = buildStoryboardTaskTypeContract().grid

  return storyboards.map((storyboard) => ({
    key: `storyboard-grid:${storyboard.id}`,
    targetType: 'NovelPromotionStoryboard',
    targetId: storyboard.id,
    types: gridTypes,
    resource: 'image',
    hasOutput: !!storyboard.sheetImageUrl,
  }))
}

function buildPanelTargets(storyboards: NovelPromotionStoryboard[], type: 'image' | 'video' | 'lip-sync'): TaskTarget[] {
  const targets: TaskTarget[] = []
  const sixGridPanelTypes = buildStoryboardTaskTypeContract().panel

  for (const storyboard of storyboards) {
    for (const panel of storyboard.panels || []) {
      if (type === 'image') {
        targets.push({
          key: `panel-image:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['image_panel', 'panel_variant', 'modify_asset_image', ...sixGridPanelTypes],
          resource: 'image',
          hasOutput: !!panel.imageUrl,
        })
      } else if (type === 'video') {
        targets.push({
          key: `panel-video:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['video_panel'],
          resource: 'video',
          hasOutput: !!panel.videoUrl,
        })
      } else {
        targets.push({
          key: `panel-lip:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['lip_sync'],
          resource: 'video',
          hasOutput: !!panel.lipSyncVideoUrl,
        })
      }
    }
  }

  return targets
}

export function useStoryboardTaskAwareStoryboards({
  projectId,
  initialStoryboards,
  isRunningPhase,
}: UseStoryboardTaskAwareStoryboardsProps) {
  const storyboardTextTargets = useMemo(
    () => buildStoryboardTextTargets(initialStoryboards),
    [initialStoryboards],
  )
  const storyboardGridTargets = useMemo(
    () => buildStoryboardGridTargets(initialStoryboards),
    [initialStoryboards],
  )
  const panelImageTargets = useMemo(
    () => buildPanelTargets(initialStoryboards, 'image'),
    [initialStoryboards],
  )
  const panelVideoTargets = useMemo(
    () => buildPanelTargets(initialStoryboards, 'video'),
    [initialStoryboards],
  )
  const panelLipSyncTargets = useMemo(
    () => buildPanelTargets(initialStoryboards, 'lip-sync'),
    [initialStoryboards],
  )

  const storyboardTextStates = useStoryboardTaskPresentation(
    projectId,
    storyboardTextTargets,
    !!projectId && storyboardTextTargets.length > 0,
  )
  const storyboardGridStates = useStoryboardTaskPresentation(
    projectId,
    storyboardGridTargets,
    !!projectId && storyboardGridTargets.length > 0,
  )
  const panelImageStates = useStoryboardTaskPresentation(
    projectId,
    panelImageTargets,
    !!projectId && panelImageTargets.length > 0,
  )
  const panelVideoStates = useStoryboardTaskPresentation(
    projectId,
    panelVideoTargets,
    !!projectId && panelVideoTargets.length > 0,
  )
  const panelLipSyncStates = useStoryboardTaskPresentation(
    projectId,
    panelLipSyncTargets,
    !!projectId && panelLipSyncTargets.length > 0,
  )

  const taskAwareStoryboards = useMemo(() => {
    return initialStoryboards.map((storyboard) => {
      const storyboardTextTaskState = storyboardTextStates.getTaskState(`storyboard-text:${storyboard.id}`)
      const episodeTextTaskState = storyboardTextStates.getTaskState(`episode-text:${storyboard.episodeId}`)
      const textTaskState = isRunningPhase(storyboardTextTaskState?.phase)
        ? storyboardTextTaskState
        : isRunningPhase(episodeTextTaskState?.phase)
          ? episodeTextTaskState
          : null
      const gridTaskState = storyboardGridStates.getTaskState(`storyboard-grid:${storyboard.id}`)
      const gridTaskRunning = isRunningPhase(gridTaskState?.phase)

      return {
        ...storyboard,
        storyboardTaskRunning: textTaskState !== null,
        storyboardTaskIntent: textTaskState?.intent,
        gridTaskRunning,
        gridTaskType: gridTaskRunning ? gridTaskState?.runningTaskType ?? null : null,
        panels: (storyboard.panels || []).map((panel) => {
          const panelImageTaskState = panelImageStates.getTaskState(`panel-image:${panel.id}`)
          const panelImageRunning = isRunningPhase(panelImageTaskState?.phase)
          return {
            ...panel,
            imageTaskRunning: panelImageRunning,
            imageTaskIntent: panelImageTaskState?.intent,
            imageTaskPresentation: panelImageStates.getState(`panel-image:${panel.id}`),
            videoTaskRunning: isRunningPhase(panelVideoStates.getTaskState(`panel-video:${panel.id}`)?.phase),
            videoTaskPresentation: panelVideoStates.getState(`panel-video:${panel.id}`),
            lipSyncTaskRunning: isRunningPhase(panelLipSyncStates.getTaskState(`panel-lip:${panel.id}`)?.phase),
            lipSyncTaskPresentation: panelLipSyncStates.getState(`panel-lip:${panel.id}`),
          }
        }),
      }
    })
  }, [
    initialStoryboards,
    isRunningPhase,
    panelImageStates,
    panelLipSyncStates,
    panelVideoStates,
    storyboardGridStates,
    storyboardTextStates,
  ])

  return {
    taskAwareStoryboards,
  }
}
