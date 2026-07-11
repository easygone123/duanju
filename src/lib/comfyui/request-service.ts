import { Prisma } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import {
  COMFY_REQUEST_STATUS,
  type ComfyMediaType,
  type ComfyRequestStatus,
  type ComfyVariableValue,
} from './types'

export const ALLOWED_COMFY_REQUEST_TRANSITIONS: Record<
  ComfyRequestStatus,
  readonly ComfyRequestStatus[]
> = {
  waiting_capacity: ['blocked_no_compatible_instance', 'leased', 'canceled'],
  blocked_no_compatible_instance: ['waiting_capacity', 'canceled'],
  leased: ['uploading', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  uploading: ['submitted', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  submitted: ['running', 'transferring', 'reconciling', 'failed', 'canceled'],
  running: ['transferring', 'reconciling', 'failed', 'canceled'],
  transferring: ['completed', 'reconciling', 'failed', 'canceled'],
  reconciling: ['submitted', 'running', 'transferring', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
}

export interface CreateComfyGenerationRequestInput {
  invocationKey: string
  userId: string
  projectId: string
  taskId: string
  mediaType: ComfyMediaType
  workflowId: string
  variables: Record<string, ComfyVariableValue>
}

interface RequestCreateDependencies {
  findInvocation(invocationKey: string, userId: string): Promise<Record<string, unknown> | null>
  findPublishedWorkflow(input: {
    id: string
    userId: string
    mediaType: ComfyMediaType
  }): Promise<Record<string, unknown> | null>
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
}

const defaultCreateDependencies: RequestCreateDependencies = {
  findInvocation: (invocationKey, userId) => prisma.comfyGenerationRequest.findFirst({
    where: { invocationKey, userId },
  }),
  findPublishedWorkflow: ({ id, userId, mediaType }) => prisma.comfyWorkflow.findFirst({
    where: { id, userId, mediaType, status: 'published' },
    include: { currentVersion: true },
  }),
  create: (data) => prisma.comfyGenerationRequest.create({
    data: data as Prisma.ComfyGenerationRequestUncheckedCreateInput,
  }),
}

export async function createComfyGenerationRequest(
  input: CreateComfyGenerationRequestInput,
  dependencies: RequestCreateDependencies = defaultCreateDependencies,
) {
  const existing = await dependencies.findInvocation(input.invocationKey, input.userId)
  if (existing) return existing
  const workflow = await dependencies.findPublishedWorkflow({
    id: input.workflowId, userId: input.userId, mediaType: input.mediaType,
  })
  const currentVersion = workflow?.currentVersion
  if (!workflow || workflow.currentVersionId === null || !isRecord(currentVersion)
    || currentVersion.id !== workflow.currentVersionId
    || currentVersion.workflowId !== workflow.id || !currentVersion.publishedAt) {
    throw new ApiError('NOT_FOUND')
  }
  const data = {
    invocationKey: input.invocationKey,
    userId: input.userId,
    projectId: input.projectId,
    taskId: input.taskId,
    mediaType: input.mediaType,
    workflowId: workflow.id,
    workflowVersionId: currentVersion.id,
    variableSnapshot: cloneJson(input.variables),
    status: COMFY_REQUEST_STATUS.WAITING_CAPACITY,
  }
  try {
    return await dependencies.create(data)
  } catch (error) {
    if (!isPrismaCode(error, 'P2002')) throw error
    const raced = await dependencies.findInvocation(input.invocationKey, input.userId)
    if (raced) return raced
    throw new ApiError('CONFLICT')
  }
}

export interface TransitionComfyGenerationRequestInput {
  requestId: string
  userId: string
  from: ComfyRequestStatus
  to: ComfyRequestStatus
  patch?: Record<string, unknown>
  now?: Date
}

interface RequestTransitionDependencies {
  updateMany(input: {
    where: { id: string; userId: string; status: ComfyRequestStatus }
    data: Record<string, unknown>
  }): Promise<{ count: number }>
}

const defaultTransitionDependencies: RequestTransitionDependencies = {
  updateMany: (input) => prisma.comfyGenerationRequest.updateMany(input),
}

export async function transitionComfyGenerationRequest(
  input: TransitionComfyGenerationRequestInput,
  dependencies: RequestTransitionDependencies = defaultTransitionDependencies,
) {
  if (!ALLOWED_COMFY_REQUEST_TRANSITIONS[input.from].includes(input.to)) {
    throw new ApiError('CONFLICT')
  }
  const now = input.now ?? new Date()
  const result = await dependencies.updateMany({
    where: { id: input.requestId, userId: input.userId, status: input.from },
    data: { ...input.patch, status: input.to, ...phaseTimestamp(input.to, now) },
  })
  if (result.count !== 1) throw new ApiError('CONFLICT')
}

function phaseTimestamp(status: ComfyRequestStatus, now: Date) {
  const field: Partial<Record<ComfyRequestStatus, string>> = {
    leased: 'leasedAt', uploading: 'uploadingAt', submitted: 'submittedAt',
    running: 'runningAt', transferring: 'transferringAt', reconciling: 'reconcilingAt',
    completed: 'completedAt', failed: 'failedAt', canceled: 'canceledAt',
  }
  return field[status] ? { [field[status]!]: now } : {}
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPrismaCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code
}
