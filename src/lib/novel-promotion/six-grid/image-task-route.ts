import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/api-errors'
import type { NormalizedCropRect, SixGridProcessingOrder } from './contracts'
import { buildSixGridTaskDedupeKey, type SixGridImageTaskSnapshot } from '@/lib/workers/handlers/storyboard-sheet-task-handler'
import { validateWorkflowContract } from '@/lib/comfyui/workflow-schema'
import type { ComfyInputBinding, ComfyOutputBinding, ComfyVariableDefinition } from '@/lib/comfyui/types'
import { resolveStoryboardGridSpec, type StoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'

function invalid(code: string, field?: string): never {
  throw new ApiError('INVALID_PARAMS', { code, ...(field ? { field } : {}) })
}

export async function loadOwnedGridStoryboard(input: {
  userId: string; projectId: string; episodeId: string; storyboardId: string
}) {
  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: {
      id: input.storyboardId, episodeId: input.episodeId,
      episode: { novelPromotionProject: { projectId: input.projectId, project: { userId: input.userId } } },
    },
    include: { sheetImageMedia: true, upscaledSheetImageMedia: true, panels: { orderBy: { gridCellIndex: 'asc' }, include: { imageMedia: true, croppedImageMedia: true } } },
  })
  if (!storyboard) throw new ApiError('NOT_FOUND')
  if (storyboard.layoutMode !== 'four_grid' && storyboard.layoutMode !== 'six_grid') invalid('GRID_LAYOUT_REQUIRED', 'storyboardId')
  if (storyboard.sixGridCellAspectRatio !== '16:9' && storyboard.sixGridCellAspectRatio !== '9:16') invalid('GRID_CELL_RATIO_INVALID')
  const gridSpec = resolveStoryboardGridSpec(storyboard.layoutMode, storyboard.sixGridCellAspectRatio)
  if (storyboard.panels.length !== gridSpec.panelCount
    || new Set(storyboard.panels.map((panel) => panel.gridCellIndex)).size !== gridSpec.panelCount
    || storyboard.panels.some((panel) => panel.gridCellIndex == null
      || panel.gridCellIndex < 0 || panel.gridCellIndex >= gridSpec.panelCount)) {
    invalid('GRID_PANEL_COUNT_INVALID', 'storyboardId')
  }
  if (storyboard.sixGridProcessingOrder !== 'sheet_upscale_then_crop' && storyboard.sixGridProcessingOrder !== 'crop_then_panel_upscale') invalid('SIX_GRID_PROCESSING_ORDER_INVALID')
  return { ...storyboard, gridSpec: { version: 1 as const, ...gridSpec } }
}

export async function loadOwnedSixGrid(input: {
  userId: string; projectId: string; episodeId: string; storyboardId: string
}) {
  const storyboard = await loadOwnedGridStoryboard(input)
  if (storyboard.gridSpec.mode !== 'six_grid') invalid('SIX_GRID_LAYOUT_REQUIRED', 'storyboardId')
  return storyboard
}

export async function loadOwnedPublishedUpscaleWorkflow(input: {
  userId: string; workflowId: string; workflowVersionId: string
}) {
  return loadOwnedPublishedTestedWorkflow({ ...input, purpose: 'upscale' })
}

export async function loadOwnedPublishedGenerationWorkflow(input: {
  userId: string
  workflowId: string
  workflowVersionId?: string
}) {
  return loadOwnedPublishedTestedWorkflow({ ...input, purpose: 'generation' })
}

async function loadOwnedPublishedTestedWorkflow(input: {
  userId: string
  workflowId: string
  workflowVersionId?: string
  purpose: 'generation' | 'upscale'
}) {
  const prefix = input.purpose === 'generation' ? 'GENERATION' : 'UPSCALE'
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: {
      id: input.workflowId, userId: input.userId, mediaType: 'image', status: 'published',
      ...(input.workflowVersionId && input.purpose === 'upscale'
        ? { currentVersionId: input.workflowVersionId }
        : {}),
    },
    include: { currentVersion: { include: { lastTestConnection: { select: { userId: true } } } } },
  })
  const version = workflow && input.workflowVersionId && input.purpose === 'generation'
    ? await prisma.comfyWorkflowVersion.findFirst({
        where: { id: input.workflowVersionId, workflowId: workflow.id },
        include: { lastTestConnection: { select: { userId: true } } },
      })
    : workflow?.currentVersion
  const field = input.purpose === 'generation' ? 'imageModel' : 'workflowVersionId'
  const requiresCurrentVersion = !input.workflowVersionId || input.purpose === 'upscale'
  if (!workflow || !version
    || (requiresCurrentVersion && workflow.currentVersionId !== version.id)
    || (input.workflowVersionId && version.id !== input.workflowVersionId)) invalid(`${prefix}_WORKFLOW_NOT_FOUND`, field)
  if (version.purpose !== input.purpose) invalid(`${prefix}_WORKFLOW_PURPOSE_INVALID`, field)
  if (!version.publishedAt) invalid(`${prefix}_WORKFLOW_UNPUBLISHED`, field)
  if (!version.contentHash.trim()) invalid(`${prefix}_WORKFLOW_UNPUBLISHED`, field)
  if (!version.lastSuccessfulTestAt || !version.lastTestConnection
    || version.lastTestConnection.userId !== input.userId) invalid(`${prefix}_WORKFLOW_NOT_VALIDATED`, field)
  const issues = validateWorkflowContract({
    purpose: input.purpose, graph: version.apiFormatJson,
    variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
    bindings: version.bindingSpec as unknown as ComfyInputBinding[],
    outputs: version.outputSpec as unknown as ComfyOutputBinding[],
  })
  if (issues.length > 0) invalid(`${prefix}_WORKFLOW_CONTRACT_INVALID`, field)
  return { workflow, version }
}

export function defaultGridCropRects(
  gridSpec: StoryboardGridSpec,
): Array<{ cellIndex: number; normalizedCropRect: NormalizedCropRect }> {
  return Array.from({ length: gridSpec.panelCount }, (_, cellIndex) => ({
    cellIndex,
    normalizedCropRect: {
      x: (cellIndex % gridSpec.columns) / gridSpec.columns,
      y: Math.floor(cellIndex / gridSpec.columns) / gridSpec.rows,
      width: 1 / gridSpec.columns,
      height: 1 / gridSpec.rows,
    },
  }))
}

export function defaultCropRects(): Array<{ cellIndex: number; normalizedCropRect: NormalizedCropRect }> {
  return defaultGridCropRects(resolveStoryboardGridSpec('six_grid', '16:9'))
}

export function sourceForGridCrop(storyboard: Awaited<ReturnType<typeof loadOwnedGridStoryboard>>) {
  const order = storyboard.sixGridProcessingOrder as SixGridProcessingOrder
  const media = order === 'sheet_upscale_then_crop' ? storyboard.upscaledSheetImageMedia : storyboard.sheetImageMedia
  if (!media) invalid(order === 'sheet_upscale_then_crop' ? 'UPSCALED_SHEET_REQUIRED' : 'SHEET_IMAGE_REQUIRED')
  return { order, media }
}

export function sourceForCrop(storyboard: Awaited<ReturnType<typeof loadOwnedSixGrid>>) {
  return sourceForGridCrop(storyboard)
}

export function finalizeSnapshot(snapshot: SixGridImageTaskSnapshot) {
  return { snapshot, dedupeKey: buildSixGridTaskDedupeKey(snapshot) }
}
