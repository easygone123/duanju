import { ApiError } from '@/lib/api-errors'
import type { ModelMediaType, ModelSelection } from '@/lib/api-config'
import type { GenerateResult } from '@/lib/generators/base'
import { prisma } from '@/lib/prisma'

import { formatComfyExternalId } from './external-id'
import { createComfyGenerationRequest } from './request-service'
import type {
  ComfyMediaRef,
  ComfyMediaType,
  ComfyStoredOutputRef,
  ComfyVariableValue,
} from './types'

export interface ComfyGenerationContext {
  projectId: string
  taskId: string
  invocationKey: string
}

export interface ComfyProviderInvocation {
  context: ComfyGenerationContext
  workflowVersionId?: string
  variables?: Record<string, ComfyVariableValue>
  inputImages?: ComfyMediaRef[]
  firstFrame?: ComfyMediaRef
  lastFrame?: ComfyMediaRef
}

interface SubmitComfyGenerationInput {
  userId: string
  workflowId: string
  workflowVersionId?: string
  prompt?: string
  context: ComfyGenerationContext
  variables?: Record<string, ComfyVariableValue>
}

export async function resolveComfyWorkflowSelection(
  userId: string,
  workflowId: string,
  mediaType: ModelMediaType,
): Promise<ModelSelection> {
  if (mediaType !== 'image' && mediaType !== 'video') throw modelNotFound(workflowId, mediaType)
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: { id: workflowId, userId, mediaType, status: 'published' },
    include: { currentVersion: true },
  })
  if (!workflow || !workflow.currentVersionId || !workflow.currentVersion
    || workflow.currentVersion.id !== workflow.currentVersionId
    || !workflow.currentVersion.publishedAt) {
    throw modelNotFound(workflowId, mediaType)
  }
  return {
    provider: 'comfyui',
    modelId: workflowId,
    modelKey: `comfyui::${workflowId}`,
    mediaType,
  }
}

export async function submitComfyImageGeneration(
  input: SubmitComfyGenerationInput,
): Promise<GenerateResult> {
  return submitComfyGeneration('image', input)
}

export async function submitComfyVideoGeneration(
  input: SubmitComfyGenerationInput,
): Promise<GenerateResult> {
  return submitComfyGeneration('video', input)
}

async function submitComfyGeneration(
  mediaType: ComfyMediaType,
  input: SubmitComfyGenerationInput,
): Promise<GenerateResult> {
  assertGenerationContext(input.context)
  const variables = {
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.variables ?? {}),
  }
  const request = await createComfyGenerationRequest({
    invocationKey: input.context.invocationKey,
    userId: input.userId,
    projectId: input.context.projectId,
    taskId: input.context.taskId,
    mediaType,
    workflowId: input.workflowId,
    ...(input.workflowVersionId ? { workflowVersionId: input.workflowVersionId } : {}),
    variables,
  })
  if (typeof request.id !== 'string' || !request.id) throw new ApiError('CONFLICT')
  return {
    success: true,
    async: true,
    externalId: formatComfyExternalId(mediaType, request.id),
  }
}

export type ComfyProgressStage =
  | 'comfy_waiting_capacity'
  | 'comfy_checking_compatibility'
  | 'comfy_uploading_inputs'
  | 'comfy_submitting'
  | 'comfy_running'
  | 'comfy_transferring_outputs'
  | 'comfy_reconciling'

export interface ComfyPollResult {
  status: 'pending' | 'completed' | 'failed'
  resultUrl?: string
  imageUrl?: string
  videoUrl?: string
  resultUrls?: string[]
  resultStorageKey?: string
  resultStorageKeys?: string[]
  stage: ComfyProgressStage
  waitingForCapacity: boolean
  error?: string
}

export async function pollComfyGenerationRequest(input: {
  requestId: string
  userId: string
  mediaType: ComfyMediaType
}): Promise<ComfyPollResult> {
  const request = await prisma.comfyGenerationRequest.findFirst({
    where: { id: input.requestId, userId: input.userId, mediaType: input.mediaType },
    select: { status: true, outputRefs: true, errorMessage: true },
  })
  if (!request) throw new ApiError('NOT_FOUND')
  const stage = stageForStatus(request.status)
  const waitingForCapacity = request.status === 'waiting_capacity'
    || request.status === 'blocked_no_compatible_instance'
  if (request.status === 'failed' || request.status === 'canceled') {
    return {
      status: 'failed', stage, waitingForCapacity,
      error: request.errorMessage || (request.status === 'canceled' ? 'Generation canceled' : 'ComfyUI generation failed'),
    }
  }
  if (request.status !== 'completed') return { status: 'pending', stage, waitingForCapacity }

  const outputs = readStoredOutputs(request.outputRefs, input.mediaType)
  const primary = outputs.find((output) => output.primary)
  if (!primary) {
    return {
      status: 'failed', stage, waitingForCapacity: false,
      error: 'ComfyUI generation completed without a primary output',
    }
  }
  const resultUrls = outputs.map((output) => output.url)
  const resultStorageKeys = outputs.map((output) => output.storageKey)
  return {
    status: 'completed', stage, waitingForCapacity: false,
    resultUrl: primary.url,
    resultStorageKey: primary.storageKey,
    ...(input.mediaType === 'image' ? { imageUrl: primary.url } : { videoUrl: primary.url }),
    resultUrls,
    resultStorageKeys,
  }
}

function readStoredOutputs(value: unknown, mediaType: ComfyMediaType): ComfyStoredOutputRef[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ComfyStoredOutputRef => {
    if (!item || typeof item !== 'object') return false
    const output = item as Partial<ComfyStoredOutputRef>
    return output.mediaType === mediaType && typeof output.url === 'string' && output.url.length > 0
      && typeof output.primary === 'boolean' && typeof output.storageKey === 'string'
  })
}

function stageForStatus(status: string): ComfyProgressStage {
  switch (status) {
    case 'waiting_capacity': return 'comfy_waiting_capacity'
    case 'blocked_no_compatible_instance':
    case 'leased': return 'comfy_checking_compatibility'
    case 'uploading': return 'comfy_uploading_inputs'
    case 'submitting': return 'comfy_submitting'
    case 'submitted':
    case 'running': return 'comfy_running'
    case 'transferring':
    case 'completed': return 'comfy_transferring_outputs'
    case 'reconciling':
    case 'failed':
    case 'canceled': return 'comfy_reconciling'
    default: throw new ApiError('CONFLICT')
  }
}

function assertGenerationContext(context: ComfyGenerationContext) {
  if (!context || !context.projectId.trim() || !context.taskId.trim() || !context.invocationKey.trim()) {
    throw new ApiError('INVALID_PARAMS')
  }
}

function modelNotFound(workflowId: string, mediaType: ModelMediaType) {
  return new Error(`MODEL_NOT_FOUND: comfyui::${workflowId} is not enabled for ${mediaType}`)
}
