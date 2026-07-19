import { ApiError } from '@/lib/api-errors'
import { resolveComfyDurationContract } from '@/lib/comfyui/duration-contract'
import type { ComfyInputBinding, ComfyVariableDefinition } from '@/lib/comfyui/types'
import { supportsComfyFirstLastFrameContract } from '@/lib/comfyui/workflow-model-option'
import {
  applyTrustedComfyVersionSnapshot,
  getProjectModelConfig,
  resolveProjectComfyWorkflowVersion,
  resolveTrustedComfyWorkflowVersion,
} from '@/lib/config-service'
import { parseModelKeyStrict, type CapabilityValue } from '@/lib/model-config-contract'
import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/model-capabilities/lookup'
import { prisma } from '@/lib/prisma'
import {
  VIDEO_DIALOGUE_MODEL_INVALID,
  VIDEO_DURATION_INVALID,
  VIDEO_DURATION_TOO_SHORT,
  VIDEO_MODEL_INVALID,
  resolvePanelVideoSubmission,
  type AvailablePanelVideoModel,
} from './panel-video-submission'
import {
  buildFrameLinkResolutionIndex,
  parseFrameSourceMeta,
  type FrameLinkStoryboard,
} from './frame-link-resolver'
import { buildFirstLastFramePrompt } from './first-last-frame-prompt'

const LEGACY_REMOTE_VIDEO_DEFAULT_DURATION_SECONDS = 5

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}

export type VideoPanelRecord = {
  id: string
  updatedAt: Date
  hasDialogue: boolean
  dialogueSpeaker: string | null
  dialogueText: string | null
  dialogueEmotion: string | null
  includeDialogueInVideoPrompt: boolean
  videoPrompt: string | null
  firstLastFramePrompt: string | null
  firstFrameSourceMeta: string | null
  lastFrameSourceMeta: string | null
  storyboard: { episodeId: string }
  estimatedDuration: number | null
  durationOverride: number | null
  duration: number | null
}

export const VIDEO_PANEL_SELECT = {
  id: true, updatedAt: true, hasDialogue: true, dialogueSpeaker: true, dialogueText: true,
  dialogueEmotion: true, includeDialogueInVideoPrompt: true, videoPrompt: true, firstLastFramePrompt: true,
  firstFrameSourceMeta: true,
  lastFrameSourceMeta: true,
  storyboard: { select: { episodeId: true } },
  estimatedDuration: true, durationOverride: true, duration: true,
} as const

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function toRuntimeSelections(value: unknown): Record<string, CapabilityValue> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([field, raw]) => (
    field !== 'aspectRatio'
    && (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
  ))) as Record<string, CapabilityValue>
}

function durationContractFor(
  modelKey: string,
  panel: VideoPanelRecord,
  variableDefinitions?: unknown,
  bindings?: unknown,
  runtimeFps?: number,
): AvailablePanelVideoModel['duration'] {
  const provider = parseModelKeyStrict(modelKey)?.provider
  if (provider === 'comfyui') {
    const resolved = resolveComfyDurationContract({
      variableDefinitions: Array.isArray(variableDefinitions)
        ? variableDefinitions as ComfyVariableDefinition[]
        : [],
      bindings: Array.isArray(bindings) ? bindings as ComfyInputBinding[] : [],
      ...(positiveNumber(runtimeFps) ? { runtimeFps } : {}),
    })
    if (resolved.kind === 'fixed') {
      return resolved.nativeConstrained
        ? { kind: 'fixed', options: resolved.options, resolution: 'exact' }
        : resolved
    }
  }
  const durationVariable = Array.isArray(variableDefinitions)
    ? variableDefinitions.find((value) => isRecord(value)
      && value.type === 'number'
      && /duration|seconds/i.test(typeof value.name === 'string' ? value.name : ''))
    : undefined
  const workflowOptions = isRecord(durationVariable) && Array.isArray(durationVariable.options)
    ? durationVariable.options.filter(positiveNumber)
    : []
  const remoteCapabilities = provider === 'comfyui'
    ? undefined
    : resolveBuiltinCapabilitiesByModelKey('video', modelKey)?.video
  const durationOptions = provider === 'comfyui'
    ? workflowOptions
    : remoteCapabilities?.durationOptions
  if (durationOptions?.length) return { kind: 'fixed', options: durationOptions }
  if (remoteCapabilities?.durationRange) {
    return { kind: 'range', ...remoteCapabilities.durationRange }
  }
  const workflowDefault = isRecord(durationVariable) && positiveNumber(durationVariable.defaultValue)
    ? durationVariable.defaultValue
    : null
  const requestedDefault = provider === 'comfyui'
    ? positiveNumber(panel.durationOverride)
      ? panel.durationOverride
      : positiveNumber(panel.estimatedDuration)
        ? panel.estimatedDuration
        : positiveNumber(panel.duration)
          ? panel.duration
          : workflowDefault
    : positiveNumber(panel.duration)
      ? panel.duration
      : positiveNumber(panel.estimatedDuration)
        ? panel.estimatedDuration
        : positiveNumber(panel.durationOverride)
          ? panel.durationOverride
          : LEGACY_REMOTE_VIDEO_DEFAULT_DURATION_SECONDS
  if (!requestedDefault) throw new ApiError('INVALID_PARAMS', { code: VIDEO_DURATION_INVALID })
  return { kind: 'provider_default', duration: requestedDefault }
}

async function isOwnedRemoteVideoModel(userId: string, modelKey: string): Promise<boolean> {
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed || parsed.provider === 'comfyui') return false
  const pref = await prisma.userPreference.findUnique({
    where: { userId }, select: { customModels: true, customProviders: true },
  })
  try {
    const models = JSON.parse(pref?.customModels || '[]') as Array<Record<string, unknown>>
    const providers = JSON.parse(pref?.customProviders || '[]') as Array<Record<string, unknown>>
    const hasModel = models.some((model) => {
      const candidate = typeof model.modelKey === 'string'
        ? parseModelKeyStrict(model.modelKey)?.modelKey
        : typeof model.provider === 'string' && typeof model.modelId === 'string'
          ? `${model.provider}::${model.modelId}`
          : null
      return candidate === modelKey && model.type === 'video'
    })
    const hasProvider = providers.some((provider) => (
      provider.id === parsed.provider
      && typeof provider.apiKey === 'string'
      && provider.apiKey.trim().length > 0
    ))
    return hasModel && hasProvider
  } catch {
    return false
  }
}

async function loadAvailableVideoModel(input: {
  modelKey: string
  userId: string
  panel: VideoPanelRecord
  trustedComfyWorkflowVersionId?: string | null
  runtimeFps?: number
  requireFirstLastFrame?: boolean
}): Promise<AvailablePanelVideoModel> {
  const parsed = parseModelKeyStrict(input.modelKey)
  if (!parsed) throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  const comfyWorkflowVersionId = parsed.provider === 'comfyui'
    ? input.trustedComfyWorkflowVersionId
      ?? await resolveTrustedComfyWorkflowVersion(input.userId, input.modelKey, 'video')
    : null
  if (parsed.provider === 'comfyui' && !comfyWorkflowVersionId) {
    throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  }
  if (parsed.provider !== 'comfyui' && !await isOwnedRemoteVideoModel(input.userId, input.modelKey)) {
    throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  }
  const comfyVersion = comfyWorkflowVersionId
    ? await prisma.comfyWorkflowVersion.findFirst({
      where: {
        id: comfyWorkflowVersionId,
        purpose: 'generation',
        publishedAt: { not: null },
        lastSuccessfulTestAt: { not: null },
        workflow: { id: parsed.modelId, userId: input.userId, mediaType: 'video', status: 'published' },
        lastTestConnection: { userId: input.userId },
      },
      select: { id: true, variableDefinitions: true, bindingSpec: true, contentHash: true },
    })
    : null
  if (comfyWorkflowVersionId && (!comfyVersion || !comfyVersion.contentHash.trim())) {
    throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  }
  if (
    parsed.provider === 'comfyui'
    && input.requireFirstLastFrame
    && !supportsComfyFirstLastFrameContract(
      comfyVersion?.variableDefinitions,
      comfyVersion?.bindingSpec,
    )
  ) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FIRSTLASTFRAME_MODEL_UNSUPPORTED',
      field: 'firstLastFrame.flModel',
    })
  }
  const duration = durationContractFor(
    input.modelKey,
    input.panel,
    comfyVersion?.variableDefinitions,
    comfyVersion?.bindingSpec,
    input.runtimeFps,
  )
  return {
    modelKey: input.modelKey,
    available: true,
    comfyWorkflowVersionId,
    duration,
  }
}

function mapSubmissionError(error: unknown): never {
  const code = error instanceof Error ? error.message : String(error)
  if ([VIDEO_DIALOGUE_MODEL_INVALID, VIDEO_MODEL_INVALID, VIDEO_DURATION_INVALID, VIDEO_DURATION_TOO_SHORT].includes(code)) {
    throw new ApiError('INVALID_PARAMS', { code })
  }
  throw error
}

async function applyDurationOverrideCas(
  body: Record<string, unknown>,
  panel: VideoPanelRecord,
): Promise<VideoPanelRecord> {
  if (!hasOwn(body, 'durationOverride')) return panel
  const override = body.durationOverride
  if (override !== null && !positiveNumber(override)) {
    throw new ApiError('INVALID_PARAMS', { code: VIDEO_DURATION_INVALID, field: 'durationOverride' })
  }
  if (typeof body.expectedPanelUpdatedAt !== 'string') {
    throw new ApiError('INVALID_PARAMS', { code: 'PANEL_VERSION_REQUIRED', field: 'expectedPanelUpdatedAt' })
  }
  const expected = new Date(body.expectedPanelUpdatedAt)
  if (!Number.isFinite(expected.getTime())) {
    throw new ApiError('INVALID_PARAMS', { code: 'PANEL_VERSION_INVALID', field: 'expectedPanelUpdatedAt' })
  }
  const result = await prisma.novelPromotionPanel.updateMany({
    where: { id: panel.id, updatedAt: expected },
    data: { durationOverride: override },
  })
  if (result.count !== 1) throw new ApiError('CONFLICT', { code: 'VIDEO_DURATION_OVERRIDE_STALE' })
  return { ...panel, durationOverride: override }
}

async function resolveTrustedFirstLastFrame(
  input: Record<string, unknown>,
  panel: VideoPanelRecord,
  projectId: string,
  userId: string,
): Promise<{
  flModel: string
  firstFrameSourcePanelId: string
  sourcePanelId?: string
  lastFrameVideoPrompt?: string | null
}> {
  const flModel = typeof input.flModel === 'string' ? input.flModel : ''
  const storedFirstFrame = parseFrameSourceMeta(panel.firstFrameSourceMeta)
  const storedLastFrame = parseFrameSourceMeta(panel.lastFrameSourceMeta)
  if (storedFirstFrame === null) {
    throw new ApiError('INVALID_PARAMS', { code: 'FIRSTLASTFRAME_SOURCE_INVALID' })
  }
  const resolveFirstFrameSourcePanelId = async () => {
    if (storedFirstFrame?.mode !== 'manual') return panel.id
    const sourcePanel = await prisma.novelPromotionPanel.findFirst({
      where: {
        id: storedFirstFrame.sourcePanelId,
        storyboard: { episode: { novelPromotionProject: { projectId, project: { userId } } } },
      },
      select: { id: true },
    })
    if (!sourcePanel) {
      throw new ApiError('INVALID_PARAMS', { code: 'VIDEO_FIRST_FRAME_SOURCE_FORBIDDEN' })
    }
    return sourcePanel.id
  }
  const resolvePersistedLastFrameSource = async (): Promise<{
    sourcePanelId?: string
    videoPrompt?: string | null
  }> => {
    if (storedLastFrame === null) return {}
    if (storedLastFrame) {
      const sourcePanel = await prisma.novelPromotionPanel.findFirst({
        where: {
          id: storedLastFrame.sourcePanelId,
          storyboard: { episode: { novelPromotionProject: { projectId, project: { userId } } } },
        },
        select: { id: true, videoPrompt: true },
      })
      if (!sourcePanel) {
        throw new ApiError('INVALID_PARAMS', { code: 'VIDEO_LAST_FRAME_SOURCE_FORBIDDEN' })
      }
      return { sourcePanelId: sourcePanel.id, videoPrompt: sourcePanel.videoPrompt }
    }

    const episodeId = panel.storyboard?.episodeId
    if (!episodeId) return {}
    const storyboardRows = await prisma.novelPromotionStoryboard.findMany({
      where: {
        episodeId,
        episode: { novelPromotionProject: { projectId, project: { userId } } },
      },
      select: {
        id: true,
        createdAt: true,
        clip: { select: { createdAt: true } },
        layoutMode: true,
        groupSequence: true,
        continuityAnchor: true,
        panels: {
          orderBy: { panelIndex: 'asc' },
          select: {
            id: true,
            storyboardId: true,
            panelIndex: true,
            gridCellIndex: true,
            firstFrameSourceMeta: true,
            lastFrameSourceMeta: true,
            linkedToNextPanel: true,
            videoPrompt: true,
          },
        },
      },
    })
    const storyboards: FrameLinkStoryboard[] = storyboardRows.map((storyboard) => ({
      id: storyboard.id,
      layoutMode: storyboard.layoutMode,
      groupSequence: storyboard.groupSequence,
      continuityAnchor: storyboard.continuityAnchor,
      createdAt: storyboard.createdAt,
      clipCreatedAt: storyboard.clip?.createdAt,
      panels: storyboard.panels,
    }))
    const sourcePanelId = buildFrameLinkResolutionIndex({ storyboards })
      .automaticChoicesByPanelId.get(panel.id)?.lastFrame?.sourcePanelId
    const sourcePanel = storyboardRows
      .flatMap((storyboard) => storyboard.panels)
      .find((candidate) => candidate.id === sourcePanelId)
    return { sourcePanelId, videoPrompt: sourcePanel?.videoPrompt }
  }

  const firstFrameSourcePanelId = await resolveFirstFrameSourcePanelId()
  const lastFrameSource = await resolvePersistedLastFrameSource()
  const sourcePanelId = lastFrameSource?.sourcePanelId
  if (!firstFrameSourcePanelId || !sourcePanelId) {
    throw new ApiError('INVALID_PARAMS', { code: 'FIRSTLASTFRAME_SOURCE_INVALID' })
  }
  return {
    flModel,
    firstFrameSourcePanelId,
    sourcePanelId,
    lastFrameVideoPrompt: lastFrameSource?.videoPrompt,
  }
}

export async function resolveAuthoritativePanelPayload(input: {
  body: Record<string, unknown>
  panel: VideoPanelRecord
  projectId: string
  userId: string
  routingMode?: 'single' | 'batch'
}) {
  const panel = await applyDurationOverrideCas(input.body, input.panel)
  const runtimeSelections = toRuntimeSelections(input.body.generationOptions)
  const isBatch = input.routingMode === 'batch'
  const firstLast = !isBatch && isRecord(input.body.firstLastFrame) ? input.body.firstLastFrame : null
  const trustedFirstLastFrame = firstLast
    ? await resolveTrustedFirstLastFrame(firstLast, panel, input.projectId, input.userId)
    : null
  const projectModels = await getProjectModelConfig(input.projectId, input.userId)
  const explicitModel = isBatch
    ? null
    : typeof trustedFirstLastFrame?.flModel === 'string'
      ? trustedFirstLastFrame.flModel
      : typeof input.body.explicitVideoModel === 'string'
        ? input.body.explicitVideoModel
        : input.body.useProjectRouting !== true && typeof input.body.videoModel === 'string'
          ? input.body.videoModel
          : null
  const automaticDialogueModel = panel.hasDialogue ? projectModels.dialogueVideoModel : null
  const selectedCandidate = explicitModel || automaticDialogueModel || projectModels.videoModel
  if (!selectedCandidate) throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  const projectDefaultComfyWorkflowVersionId = !explicitModel && !automaticDialogueModel
    ? resolveProjectComfyWorkflowVersion(projectModels, selectedCandidate, 'video')
    : null
  let models: AvailablePanelVideoModel[]
  try {
    models = [await loadAvailableVideoModel({
      modelKey: selectedCandidate,
      userId: input.userId,
      panel,
      trustedComfyWorkflowVersionId: projectDefaultComfyWorkflowVersionId,
      runtimeFps: positiveNumber(runtimeSelections.fps) ? runtimeSelections.fps : undefined,
      requireFirstLastFrame: Boolean(trustedFirstLastFrame),
    })]
  } catch (error) {
    if (!explicitModel && automaticDialogueModel) {
      throw new ApiError('INVALID_PARAMS', { code: VIDEO_DIALOGUE_MODEL_INVALID })
    }
    throw error
  }
  let submission
  try {
    const firstLastFramePrompt = trustedFirstLastFrame
      ? panel.firstLastFramePrompt?.trim()
        || buildFirstLastFramePrompt(panel.videoPrompt, trustedFirstLastFrame.lastFrameVideoPrompt)
      : panel.videoPrompt
    submission = resolvePanelVideoSubmission({
      panel: {
        ...panel,
        videoPrompt: firstLastFramePrompt,
        legacyDuration: panel.duration,
      },
      project: { videoModel: projectModels.videoModel, dialogueVideoModel: projectModels.dialogueVideoModel },
      explicitModelSelection: explicitModel,
      models,
    })
  } catch (error) {
    mapSubmissionError(error)
  }
  const payload = { ...input.body }
  delete payload.submittedPrompt
  delete payload.customPrompt
  delete payload.explicitVideoModel
  delete payload.requestedDuration
  delete payload.effectiveDuration
  delete payload.comfyWorkflowVersionId
  delete payload.firstLastFrame
  if (trustedFirstLastFrame) {
    payload.firstLastFrame = {
      flModel: trustedFirstLastFrame.flModel,
      firstFrameSourcePanelId: trustedFirstLastFrame.firstFrameSourcePanelId,
      sourcePanelId: trustedFirstLastFrame.sourcePanelId,
    }
  }
  payload.videoModel = submission.selectedModel
  payload.videoModelReason = submission.modelReason
  payload.videoPrompt = submission.submittedPrompt
  payload.requestedDuration = submission.requestedDuration
  payload.effectiveDuration = submission.effectiveDuration
  payload.durationSource = submission.durationSource
  payload.generationOptions = { ...runtimeSelections, duration: submission.effectiveDuration }
  applyTrustedComfyVersionSnapshot(payload, submission.snapshot.comfyWorkflowVersionId)
  payload.comfyModelSnapshotVersion = 1
  return payload
}
