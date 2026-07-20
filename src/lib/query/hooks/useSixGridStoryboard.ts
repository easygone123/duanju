'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { resolveTaskErrorMessage } from '@/lib/task/error-message'
import { queryKeys } from '@/lib/query/keys'
import { clearTaskTargetOverlay, upsertTaskTargetOverlay } from '@/lib/query/task-target-overlay'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { TASK_TYPE } from '@/lib/task/types'
import type { NormalizedCropRect } from '@/types/project'

type CropEntry = { cellIndex: number; normalizedCropRect: NormalizedCropRect }
type SheetTaskInput = {
  operation: 'generate' | 'upscale'; episodeId: string; storyboardId: string
  imageModel?: string; workflowId?: string; workflowVersionId?: string; prompt?: string
}
export type SheetUploadInput = {
  file: File
  episodeId: string
  storyboardId: string
  expectedSheetArtifactVersion: number
}
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
// Upload is synchronous, but its optimistic overlay still needs a non-text identity.
const STORYBOARD_SHEET_UPLOAD_OVERLAY_TYPE = 'storyboard_sheet_upload'

function clearStoryboardError(errors: Record<string, string>, storyboardId: string) {
  if (!(storyboardId in errors)) return errors
  const next = { ...errors }
  delete next[storyboardId]
  return next
}

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

/** Neutral alias; the persisted key prefix remains unchanged for cache compatibility. */
export const gridStoryboardQueryKeys = sixGridStoryboardQueryKeys

function refreshStoryboardGroupQueries(
  queryClient: QueryClient,
  projectId: string,
  episodeId: string,
  storyboardId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: sixGridStoryboardQueryKeys.group(projectId, episodeId, storyboardId),
      exact: true,
    }),
    invalidateEpisodeStageQueries(queryClient, projectId, episodeId),
  ])
}

export function buildSheetTaskRequest(projectId: string, body: SheetTaskInput) {
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-sheet`, body }
}

export function buildSheetUploadRequest(projectId: string, input: SheetUploadInput) {
  const body = new FormData()
  body.set('file', input.file)
  body.set('episodeId', input.episodeId)
  body.set('storyboardId', input.storyboardId)
  body.set('expectedSheetArtifactVersion', String(input.expectedSheetArtifactVersion))
  return { endpoint: `/api/novel-promotion/${projectId}/storyboard-sheet/upload`, body }
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

async function submitSheetUpload(request: { endpoint: string; body: FormData }) {
  const response = await apiFetch(request.endpoint, { method: 'POST', body: request.body })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(resolveTaskErrorMessage(error, 'Failed to upload six-grid sheet'))
  }
  return response.json()
}

export function createSheetUploadMutationOptions(
  queryClient: QueryClient,
  projectId: string,
  episodeId: string,
) {
  return {
    mutationFn: (input: SheetUploadInput) => submitSheetUpload(buildSheetUploadRequest(projectId, input)),
    onMutate: (input: SheetUploadInput) => upsertTaskTargetOverlay(queryClient, {
      projectId,
      targetType: 'NovelPromotionStoryboard',
      targetId: input.storyboardId,
      runningTaskType: STORYBOARD_SHEET_UPLOAD_OVERLAY_TYPE,
      intent: 'process',
    }),
    onSuccess: async (_data: unknown, input: SheetUploadInput) => {
      try {
        await refreshStoryboardGroupQueries(queryClient, projectId, episodeId, input.storyboardId)
      } catch {
        // The upload is already durable; a later query refresh can recover stale cache data.
      }
    },
    onSettled: (_data: unknown, _error: Error | null, input: SheetUploadInput) => clearTaskTargetOverlay(queryClient, {
      projectId,
      targetType: 'NovelPromotionStoryboard',
      targetId: input.storyboardId,
    }),
  }
}

export function createSheetTaskMutationOptions(
  queryClient: QueryClient,
  projectId: string,
  episodeId: string,
  setGenerationError: (storyboardId: string, error: string | null) => void,
  nextAttempt: (storyboardId: string) => number,
  currentAttempt: (storyboardId: string) => number | undefined,
) {
  return {
    mutationFn: (input: SheetTaskInput) => submitTask(buildSheetTaskRequest(projectId, input)),
    onMutate: (input: SheetTaskInput) => {
      const attempt = nextAttempt(input.storyboardId)
      if (input.operation === 'generate') setGenerationError(input.storyboardId, null)
      upsertTaskTargetOverlay(queryClient, {
        projectId,
        targetType: 'NovelPromotionStoryboard',
        targetId: input.storyboardId,
        runningTaskType: input.operation === 'generate'
          ? TASK_TYPE.STORYBOARD_SHEET_GENERATE
          : TASK_TYPE.STORYBOARD_SHEET_UPSCALE,
        intent: input.operation === 'generate' ? 'generate' : 'process',
      })
      return { attempt }
    },
    onError: (error: Error, input: SheetTaskInput, context: { attempt: number } | undefined) => {
      if (context?.attempt !== currentAttempt(input.storyboardId)) return
      clearTaskTargetOverlay(queryClient, {
        projectId,
        targetType: 'NovelPromotionStoryboard',
        targetId: input.storyboardId,
      })
      if (input.operation === 'generate') {
        setGenerationError(input.storyboardId, error instanceof Error ? error.message : String(error))
      }
    },
    onSuccess: (_data: unknown, input: SheetTaskInput, context: { attempt: number } | undefined) => {
      if (input.operation === 'generate'
        && context?.attempt === currentAttempt(input.storyboardId)) {
        setGenerationError(input.storyboardId, null)
      }
      return refreshStoryboardGroupQueries(queryClient, projectId, episodeId, input.storyboardId)
    },
  }
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
  const [generationErrorsByStoryboardId, setGenerationErrorsByStoryboardId] = useState<Record<string, string>>({})
  const sheetAttemptByStoryboardId = useRef<Record<string, number>>({})
  const nextSheetAttempt = useCallback((storyboardId: string) => {
    const attempt = (sheetAttemptByStoryboardId.current[storyboardId] ?? 0) + 1
    sheetAttemptByStoryboardId.current[storyboardId] = attempt
    return attempt
  }, [])
  const currentSheetAttempt = useCallback(
    (storyboardId: string) => sheetAttemptByStoryboardId.current[storyboardId],
    [],
  )
  const setGenerationError = useCallback((storyboardId: string, error: string | null) => {
    setGenerationErrorsByStoryboardId((errors) => error === null
      ? clearStoryboardError(errors, storyboardId)
      : { ...errors, [storyboardId]: error })
  }, [])
  const refreshGroup = (storyboardId: string) => refreshStoryboardGroupQueries(
    queryClient,
    projectId,
    episodeId,
    storyboardId,
  )
  const clearOverlay = (targetType: string, targetId: string) =>
    clearTaskTargetOverlay(queryClient, { projectId, targetType, targetId })

  const sheetOptions = useMemo(() => createSheetTaskMutationOptions(
    queryClient,
    projectId,
    episodeId,
    setGenerationError,
    nextSheetAttempt,
    currentSheetAttempt,
  ), [currentSheetAttempt, episodeId, nextSheetAttempt, projectId, queryClient, setGenerationError])
  const sheet = useMutation(sheetOptions)
  const crop = useMutation({
    mutationFn: (input: CropTaskInput) => submitTask(buildSheetCropRequest(projectId, input)),
    onMutate: (input) => upsertTaskTargetOverlay(queryClient, {
      projectId, targetType: 'NovelPromotionStoryboard', targetId: input.storyboardId,
      runningTaskType: TASK_TYPE.STORYBOARD_SHEET_CROP, intent: 'process',
    }),
    onError: (_error, input) => clearOverlay('NovelPromotionStoryboard', input.storyboardId),
    onSuccess: (_data, input) => refreshGroup(input.storyboardId),
  })
  const panelUpscale = useMutation({
    mutationFn: (input: PanelUpscaleInput) => submitTask(buildPanelUpscaleRequest(projectId, input)),
    onMutate: (input) => upsertTaskTargetOverlay(queryClient, {
      projectId, targetType: 'NovelPromotionPanel', targetId: input.panelId,
      runningTaskType: TASK_TYPE.STORYBOARD_PANEL_UPSCALE, intent: 'process',
    }),
    onError: (_error, input) => clearOverlay('NovelPromotionPanel', input.panelId),
    onSuccess: (_data, input) => Promise.all([
      queryClient.invalidateQueries({ queryKey: sixGridStoryboardQueryKeys.panel(projectId, episodeId, input.storyboardId, input.panelId), exact: true }),
      invalidateEpisodeStageQueries(queryClient, projectId, episodeId),
    ]),
  })
  const upload = useMutation(createSheetUploadMutationOptions(queryClient, projectId, episodeId))
  const undo = useMutation(createPanelUndoMutationOptions(queryClient, projectId, episodeId))

  return { sheet, crop, panelUpscale, upload, undo, generationErrorsByStoryboardId }
}

/** Four-grid and six-grid intentionally share the same mutation family. */
export const useGridStoryboard = useSixGridStoryboard
export const isGridPanelBusy = isSixGridPanelBusy
export const isGridGroupBusy = isSixGridGroupBusy

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
