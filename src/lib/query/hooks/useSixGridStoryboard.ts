'use client'

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { resolveTaskErrorMessage } from '@/lib/task/error-message'
import { queryKeys } from '@/lib/query/keys'
import { clearTaskTargetOverlay, upsertTaskTargetOverlay } from '@/lib/query/task-target-overlay'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import type { NormalizedCropRect } from '@/types/project'

type CropEntry = { cellIndex: number; normalizedCropRect: NormalizedCropRect }
type SheetTaskInput = {
  operation: 'generate' | 'upscale'; episodeId: string; storyboardId: string
  imageModel?: string; workflowId?: string; workflowVersionId?: string; prompt?: string
}
export type SixGridSheetError = { storyboardId: string | null; message: string }
type CropTaskInput = { episodeId: string; storyboardId: string; cropRects: CropEntry[] }
type PanelUpscaleInput = {
  episodeId: string; storyboardId: string; panelId: string
  workflowId: string; workflowVersionId: string; generationOptions?: { resolution?: string }
}
type PanelUndoInput = {
  panelId: string; storyboardId: string
  expectedCurrentMediaId: string; expectedPreviousMediaId: string
}

const PANEL_IMAGE_LINEAGE_KEYS = [
  'imageUrl', 'imageMediaId', 'media',
  'previousImageUrl', 'previousImageMediaId', 'previousImageMedia',
] as const

type PanelRecord = Record<string, unknown>

export function isSixGridPanelBusy(
  localPanelId: string | null,
  panelId: string,
  serverImageTaskRunning: boolean,
  groupTaskRunning = false,
) {
  return localPanelId === panelId || serverImageTaskRunning || groupTaskRunning
}

export function isSixGridGroupBusy(localGroupTaskRunning: boolean, serverGroupTaskRunning: boolean) {
  return localGroupTaskRunning || serverGroupTaskRunning
}

export const sixGridStoryboardQueryKeys = {
  group: (projectId: string, episodeId: string, storyboardId: string) =>
    ['six-grid-storyboard', projectId, episodeId, storyboardId] as const,
  panel: (projectId: string, episodeId: string, storyboardId: string, panelId: string) =>
    ['six-grid-storyboard', projectId, episodeId, storyboardId, panelId] as const,
}

export function buildSheetTaskRequest(projectId: string, body: SheetTaskInput) {
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-sheet`, body }
}

export function buildSheetCropRequest(projectId: string, body: CropTaskInput) {
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-sheet/crop`, body }
}

export function buildPanelUpscaleRequest(projectId: string, body: PanelUpscaleInput) {
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-panel/upscale`, body }
}

export function buildPanelUndoRequest(projectId: string, input: {
  panelId: string; expectedCurrentMediaId: string; expectedPreviousMediaId: string
}) {
  return { endpoint: `/api/novel-promotion/${projectId}/panel`, method: 'PATCH' as const, body: {
    panelId: input.panelId, restorePreviousImage: true,
    expectedCurrentMediaId: input.expectedCurrentMediaId,
    expectedPreviousMediaId: input.expectedPreviousMediaId,
  } }
}

async function submitTask(request: { endpoint: string; method?: 'POST' | 'PATCH'; body: unknown }) {
  const response = await apiFetch(request.endpoint, {
    method: request.method ?? 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(resolveTaskErrorMessage(error, 'Failed to submit six-grid task'))
  }
  return response.json()
}

export function createPanelUndoMutationOptions(
  queryClient: QueryClient,
  projectId: string,
  episodeId: string,
) {
  return {
    mutationFn: (input: PanelUndoInput) => submitTask(buildPanelUndoRequest(projectId, input)),
    onMutate: async (input: PanelUndoInput) => {
      const key = queryKeys.episodeStage(projectId, episodeId, 'storyboard')
      await queryClient.cancelQueries({ queryKey: key, exact: true })
      const previous = findPanelRecord(queryClient.getQueryData(key), input.panelId)
      queryClient.setQueryData(key, (value: unknown) => swapPanelImageWithPrevious(value, input.panelId))
      const optimistic = findPanelRecord(queryClient.getQueryData(key), input.panelId)
      return { previous, optimistic }
    },
    onError: (_error: Error, input: PanelUndoInput, context: {
      previous: PanelRecord | undefined; optimistic: PanelRecord | undefined
    } | undefined) => {
      if (context?.previous && context.optimistic) {
        queryClient.setQueryData(queryKeys.episodeStage(projectId, episodeId, 'storyboard'), (current: unknown) => (
          rollbackPanelImageIfStillOptimistic(current, input.panelId, context.previous!, context.optimistic!)
        ))
      }
    },
    onSuccess: (_data: unknown, input: PanelUndoInput) => Promise.all([
      queryClient.invalidateQueries({ queryKey: sixGridStoryboardQueryKeys.panel(projectId, episodeId, input.storyboardId, input.panelId), exact: true }),
      invalidateEpisodeStageQueries(queryClient, projectId, episodeId),
    ]),
  }
}

function findPanelRecord(value: unknown, panelId: string): PanelRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const root = value as {
    episode?: { storyboards?: Array<{ panels?: PanelRecord[] }> }
    storyboards?: Array<{ panels?: PanelRecord[] }>
  }
  const storyboards = root.episode?.storyboards ?? root.storyboards
  if (!Array.isArray(storyboards)) return undefined
  for (const storyboard of storyboards) {
    const panel = storyboard.panels?.find((candidate) => candidate.id === panelId)
    if (panel) return { ...panel }
  }
  return undefined
}

function rollbackPanelImageIfStillOptimistic(
  value: unknown,
  panelId: string,
  previous: PanelRecord,
  optimistic: PanelRecord,
) {
  if (!value || typeof value !== 'object') return value
  const root = value as {
    episode?: Record<string, unknown> & { storyboards?: Array<{ panels?: PanelRecord[] }> }
    storyboards?: Array<{ panels?: PanelRecord[] }>
  }
  const storyboardsRoot = root.episode ?? root
  if (!Array.isArray(storyboardsRoot.storyboards)) return value
  let changed = false
  const storyboards = storyboardsRoot.storyboards.map((storyboard) => {
    if (!Array.isArray(storyboard.panels)) return storyboard
    const panels = storyboard.panels.map((panel) => {
      if (panel.id !== panelId) return panel
      const stillOptimistic = PANEL_IMAGE_LINEAGE_KEYS.every((key) => panel[key] === optimistic[key])
      if (!stillOptimistic) return panel
      changed = true
      const restored = { ...panel }
      for (const key of PANEL_IMAGE_LINEAGE_KEYS) restored[key] = previous[key]
      return restored
    })
    return { ...storyboard, panels }
  })
  if (!changed) return value
  return root.episode
    ? { ...root, episode: { ...root.episode, storyboards } }
    : { ...root, storyboards }
}

export function useSixGridStoryboard(projectId: string, episodeId: string) {
  const queryClient = useQueryClient()
  const refreshGroup = (storyboardId: string) => Promise.all([
    queryClient.invalidateQueries({ queryKey: sixGridStoryboardQueryKeys.group(projectId, episodeId, storyboardId), exact: true }),
    invalidateEpisodeStageQueries(queryClient, projectId, episodeId),
  ])
  const clearOverlay = (targetType: string, targetId: string) =>
    clearTaskTargetOverlay(queryClient, { projectId, targetType, targetId })

  const sheet = useMutation({
    mutationFn: (input: SheetTaskInput) => submitTask(buildSheetTaskRequest(projectId, input)),
    onMutate: (input) => upsertTaskTargetOverlay(queryClient, {
      projectId, targetType: 'NovelPromotionStoryboard', targetId: input.storyboardId,
      intent: input.operation === 'generate' ? 'generate' : 'process',
    }),
    onError: (_error, input) => clearOverlay('NovelPromotionStoryboard', input.storyboardId),
    onSuccess: (_data, input) => refreshGroup(input.storyboardId),
  })
  const crop = useMutation({
    mutationFn: (input: CropTaskInput) => submitTask(buildSheetCropRequest(projectId, input)),
    onMutate: (input) => upsertTaskTargetOverlay(queryClient, {
      projectId, targetType: 'NovelPromotionStoryboard', targetId: input.storyboardId, intent: 'process',
    }),
    onError: (_error, input) => clearOverlay('NovelPromotionStoryboard', input.storyboardId),
    onSuccess: (_data, input) => refreshGroup(input.storyboardId),
  })
  const panelUpscale = useMutation({
    mutationFn: (input: PanelUpscaleInput) => submitTask(buildPanelUpscaleRequest(projectId, input)),
    onMutate: (input) => upsertTaskTargetOverlay(queryClient, {
      projectId, targetType: 'NovelPromotionPanel', targetId: input.panelId, intent: 'process',
    }),
    onError: (_error, input) => clearOverlay('NovelPromotionPanel', input.panelId),
    onSuccess: (_data, input) => Promise.all([
      queryClient.invalidateQueries({ queryKey: sixGridStoryboardQueryKeys.panel(projectId, episodeId, input.storyboardId, input.panelId), exact: true }),
      invalidateEpisodeStageQueries(queryClient, projectId, episodeId),
    ]),
  })
  const undo = useMutation(createPanelUndoMutationOptions(queryClient, projectId, episodeId))

  return { sheet, crop, panelUpscale, undo }
}

export function swapPanelImageWithPrevious(value: unknown, panelId: string): unknown {
  if (!value || typeof value !== 'object') return value
  const root = value as {
    episode?: Record<string, unknown> & { storyboards?: Array<{ panels?: Array<Record<string, unknown>> }> }
    storyboards?: Array<{ panels?: Array<Record<string, unknown>> }>
  }
  const storyboardsRoot = root.episode ?? root
  if (!Array.isArray(storyboardsRoot.storyboards)) return value
  let changed = false
  const storyboards = storyboardsRoot.storyboards.map((storyboard) => {
    if (!Array.isArray(storyboard.panels)) return storyboard
    const panels = storyboard.panels.map((panel) => {
      if (panel.id !== panelId || !panel.previousImageUrl) return panel
      changed = true
      return {
        ...panel,
        imageUrl: panel.previousImageUrl,
        imageMediaId: panel.previousImageMediaId,
        media: panel.previousImageMedia,
        previousImageUrl: panel.imageUrl,
        previousImageMediaId: panel.imageMediaId,
        previousImageMedia: panel.media,
      }
    })
    return panels === storyboard.panels ? storyboard : { ...storyboard, panels }
  })
  if (!changed) return value
  return root.episode
    ? { ...root, episode: { ...root.episode, storyboards } }
    : { ...root, storyboards }
}
