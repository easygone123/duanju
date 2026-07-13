import { ApiError } from '@/lib/api-errors'
import {
  applyTrustedComfyVersionSnapshot,
  getProjectModelConfig,
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
  estimatedDuration: number | null
  durationOverride: number | null
  duration: number | null
}

export const VIDEO_PANEL_SELECT = {
  id: true, updatedAt: true, hasDialogue: true, dialogueSpeaker: true, dialogueText: true,
  dialogueEmotion: true, includeDialogueInVideoPrompt: true, videoPrompt: true, firstLastFramePrompt: true,
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
): AvailablePanelVideoModel['duration'] {
  const provider = parseModelKeyStrict(modelKey)?.provider
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
    ? workflowDefault
    : positiveNumber(panel.duration)
      ? panel.duration
      : positiveNumber(panel.estimatedDuration)
        ? panel.estimatedDuration
        : positiveNumber(panel.durationOverride)
          ? panel.durationOverride
          : provider === 'comfyui'
            ? null
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
}): Promise<AvailablePanelVideoModel> {
  const parsed = parseModelKeyStrict(input.modelKey)
  if (!parsed) throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  const comfyWorkflowVersionId = parsed.provider === 'comfyui'
    ? await resolveTrustedComfyWorkflowVersion(input.userId, input.modelKey, 'video')
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
        publishedAt: { not: null },
        lastSuccessfulTestAt: { not: null },
        workflow: { userId: input.userId, mediaType: 'video', status: 'published', currentVersionId: comfyWorkflowVersionId },
        lastTestConnection: { userId: input.userId },
      },
      select: { id: true, variableDefinitions: true },
    })
    : null
  if (comfyWorkflowVersionId && !comfyVersion) {
    throw new ApiError('INVALID_PARAMS', { code: VIDEO_MODEL_INVALID })
  }
  return {
    modelKey: input.modelKey,
    available: true,
    comfyWorkflowVersionId,
    duration: durationContractFor(input.modelKey, input.panel, comfyVersion?.variableDefinitions),
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
  projectId: string,
  userId: string,
): Promise<{ flModel: string; sourcePanelId?: string }> {
  const flModel = typeof input.flModel === 'string' ? input.flModel : ''
  const hasStoryboard = Object.prototype.hasOwnProperty.call(input, 'lastFrameStoryboardId')
  const hasPanelIndex = Object.prototype.hasOwnProperty.call(input, 'lastFramePanelIndex')
  if (!hasStoryboard && !hasPanelIndex) return { flModel }

  const storyboardId = typeof input.lastFrameStoryboardId === 'string'
    ? input.lastFrameStoryboardId.trim()
    : ''
  const panelIndex = input.lastFramePanelIndex
  if (!storyboardId || typeof panelIndex !== 'number' || !Number.isInteger(panelIndex) || panelIndex < 0) {
    throw new ApiError('INVALID_PARAMS', { code: 'FIRSTLASTFRAME_SOURCE_INVALID' })
  }
  const sourcePanel = await prisma.novelPromotionPanel.findFirst({
    where: {
      storyboardId,
      panelIndex,
      storyboard: { episode: { novelPromotionProject: { projectId, project: { userId } } } },
    },
    select: { id: true },
  })
  if (!sourcePanel) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIDEO_LAST_FRAME_SOURCE_FORBIDDEN' })
  }
  return { flModel, sourcePanelId: sourcePanel.id }
}

export async function resolveAuthoritativePanelPayload(input: {
  body: Record<string, unknown>
  panel: VideoPanelRecord
  projectId: string
  userId: string
  routingMode?: 'single' | 'batch'
}) {
  const panel = await applyDurationOverrideCas(input.body, input.panel)
  const projectModels = await getProjectModelConfig(input.projectId, input.userId)
  const isBatch = input.routingMode === 'batch'
  const firstLast = !isBatch && isRecord(input.body.firstLastFrame) ? input.body.firstLastFrame : null
  const trustedFirstLastFrame = firstLast
    ? await resolveTrustedFirstLastFrame(firstLast, input.projectId, input.userId)
    : null
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
  let models: AvailablePanelVideoModel[]
  try {
    models = [await loadAvailableVideoModel({
      modelKey: selectedCandidate, userId: input.userId, panel,
    })]
  } catch (error) {
    if (!explicitModel && automaticDialogueModel) {
      throw new ApiError('INVALID_PARAMS', { code: VIDEO_DIALOGUE_MODEL_INVALID })
    }
    throw error
  }
  let submission
  try {
    submission = resolvePanelVideoSubmission({
      panel: {
        ...panel,
        videoPrompt: trustedFirstLastFrame ? panel.firstLastFramePrompt || panel.videoPrompt : panel.videoPrompt,
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
  if (trustedFirstLastFrame) payload.firstLastFrame = trustedFirstLastFrame
  payload.videoModel = submission.selectedModel
  payload.videoModelReason = submission.modelReason
  payload.videoPrompt = submission.submittedPrompt
  payload.requestedDuration = submission.requestedDuration
  payload.effectiveDuration = submission.effectiveDuration
  payload.durationSource = submission.durationSource
  payload.generationOptions = { ...toRuntimeSelections(payload.generationOptions), duration: submission.effectiveDuration }
  applyTrustedComfyVersionSnapshot(payload, submission.snapshot.comfyWorkflowVersionId)
  payload.comfyModelSnapshotVersion = 1
  return payload
}
