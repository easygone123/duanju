import { Prisma } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import {
  COMFY_REQUEST_STATUS,
  type ComfyMediaType,
  type ComfyMediaRef,
  type ComfyRequestStatus,
  type ComfyVariableValue,
} from './types'
import { isBoundedLiveVariables } from './workflow-limits'
import { matchesComfyVariableType } from './workflow-schema'
import type { ComfyVariableDefinition } from './types'

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

interface RequestCreateOperations {
  findInvocation(invocationKey: string, userId: string): Promise<Record<string, unknown> | null>
  findPublishedWorkflow(input: {
    id: string
    userId: string
    mediaType: ComfyMediaType
  }): Promise<Record<string, unknown> | null>
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface RequestCreateDependencies extends RequestCreateOperations {
  transaction<T>(operation: (client: RequestCreateOperations) => Promise<T>): Promise<T>
}

const defaultCreateOperations: RequestCreateOperations = {
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

const defaultCreateDependencies: RequestCreateDependencies = {
  ...defaultCreateOperations,
  transaction: (operation) => prisma.$transaction((tx) => operation({
    findInvocation: (invocationKey, userId) => tx.comfyGenerationRequest.findFirst({
      where: { invocationKey, userId },
    }),
    findPublishedWorkflow: ({ id, userId, mediaType }) => tx.comfyWorkflow.findFirst({
      where: { id, userId, mediaType, status: 'published' },
      include: { currentVersion: true },
    }),
    create: (data) => tx.comfyGenerationRequest.create({
      data: data as Prisma.ComfyGenerationRequestUncheckedCreateInput,
    }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
}

export async function createComfyGenerationRequest(
  input: CreateComfyGenerationRequestInput,
  dependencies: RequestCreateDependencies = defaultCreateDependencies,
) {
  const existing = await dependencies.findInvocation(input.invocationKey, input.userId)
  if (existing) return existing
  try {
    return await dependencies.transaction(async (client) => {
      const workflow = await client.findPublishedWorkflow({
        id: input.workflowId, userId: input.userId, mediaType: input.mediaType,
      })
      const currentVersion = workflow?.currentVersion
      if (!workflow || workflow.currentVersionId === null || !isRecord(currentVersion)
        || currentVersion.id !== workflow.currentVersionId
        || currentVersion.workflowId !== workflow.id || !currentVersion.publishedAt) {
        throw new ApiError('NOT_FOUND')
      }
      const variableSnapshot = sanitizeVariableSnapshot(
        input.variables, currentVersion.variableDefinitions,
      )
      return client.create({
        invocationKey: input.invocationKey,
        userId: input.userId,
        projectId: input.projectId,
        taskId: input.taskId,
        mediaType: input.mediaType,
        workflowId: workflow.id,
        workflowVersionId: currentVersion.id,
        variableSnapshot,
        status: COMFY_REQUEST_STATUS.WAITING_CAPACITY,
      })
    })
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
  patch?: ComfyTransitionPatch
  expectedLeaseId?: string
  now?: Date
}

interface RequestTransitionDependencies {
  updateMany(input: {
    where: { id: string; userId: string; status: ComfyRequestStatus; leaseId?: string }
    data: Record<string, unknown>
  }): Promise<{ count: number }>
  findCurrent(requestId: string, userId: string): Promise<Record<string, unknown> | null>
}

const defaultTransitionDependencies: RequestTransitionDependencies = {
  updateMany: (input) => prisma.comfyGenerationRequest.updateMany(input),
  findCurrent: (requestId, userId) => prisma.comfyGenerationRequest.findFirst({
    where: { id: requestId, userId },
  }),
}

export type ComfyTransitionPatch = Partial<{
  connectionId: string | null
  leaseId: string | null
  leaseExpiresAt: Date | null
  promptId: string | null
  clientId: string | null
  outputRefs: unknown
  errorCode: string | null
  errorMessage: string | null
  nodeErrors: unknown
}>

const TRANSITION_PATCH_FIELDS: Record<ComfyRequestStatus, readonly (keyof ComfyTransitionPatch)[]> = {
  waiting_capacity: ['connectionId', 'leaseId', 'leaseExpiresAt'],
  blocked_no_compatible_instance: [],
  leased: ['connectionId', 'leaseId', 'leaseExpiresAt'],
  uploading: [],
  submitted: ['promptId', 'clientId'],
  running: ['promptId', 'clientId'],
  transferring: ['outputRefs'],
  reconciling: ['promptId', 'clientId'],
  completed: ['outputRefs'],
  failed: ['errorCode', 'errorMessage', 'nodeErrors'],
  canceled: ['errorCode', 'errorMessage'],
}

export async function transitionComfyGenerationRequest(
  input: TransitionComfyGenerationRequestInput,
  dependencies: RequestTransitionDependencies = defaultTransitionDependencies,
) {
  if (!ALLOWED_COMFY_REQUEST_TRANSITIONS[input.from].includes(input.to)) {
    throw new ApiError('CONFLICT')
  }
  if (LEASE_OWNED_STATUSES.has(input.from) && !validOwnerToken(input.expectedLeaseId)) {
    throw new ApiError('INVALID_PARAMS')
  }
  if (input.expectedLeaseId !== undefined && !validOwnerToken(input.expectedLeaseId)) {
    throw new ApiError('INVALID_PARAMS')
  }
  const now = input.now ?? new Date()
  validateTransitionPatch(input, now)
  const result = await dependencies.updateMany({
    where: {
      id: input.requestId, userId: input.userId, status: input.from,
      ...(LEASE_OWNED_STATUSES.has(input.from) ? { leaseId: input.expectedLeaseId } : {}),
    },
    data: {
      ...input.patch,
      status: input.to,
      ...(input.expectedLeaseId ? { lastTransitionToken: input.expectedLeaseId } : {}),
      ...phaseTimestamp(input.to, now),
    },
  })
  if (result.count === 1) return
  const current = await dependencies.findCurrent(input.requestId, input.userId)
  if (current?.status === input.to
    && retryOwnerMatches(current, input)
    && patchMatches(current, input.patch)) return
  throw new ApiError('CONFLICT')
}

const LEASE_OWNED_STATUSES = new Set<ComfyRequestStatus>([
  'leased', 'uploading', 'submitted', 'running', 'transferring', 'reconciling',
])

function validOwnerToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 191
}

function validateTransitionPatch(input: TransitionComfyGenerationRequestInput, now: Date) {
  const { to: status, patch } = input
  if (!patch) {
    if (status === 'leased'
      || (status === 'waiting_capacity' && LEASE_OWNED_STATUSES.has(input.from))) {
      throw new ApiError('INVALID_PARAMS')
    }
    return
  }
  const allowed = new Set<string>(TRANSITION_PATCH_FIELDS[status])
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key) || !validPatchValue(key, value)) throw new ApiError('INVALID_PARAMS')
  }
  if (status === 'leased') {
    if (!validOwnerToken(patch.connectionId) || !validOwnerToken(patch.leaseId)
      || !(patch.leaseExpiresAt instanceof Date)
      || !Number.isFinite(patch.leaseExpiresAt.getTime())
      || patch.leaseExpiresAt.getTime() <= now.getTime()
      || input.expectedLeaseId !== patch.leaseId) {
      throw new ApiError('INVALID_PARAMS')
    }
  }
  if (status === 'waiting_capacity' && LEASE_OWNED_STATUSES.has(input.from)
    && (patch.connectionId !== null || patch.leaseId !== null || patch.leaseExpiresAt !== null)) {
    throw new ApiError('INVALID_PARAMS')
  }
}

function retryOwnerMatches(
  current: Record<string, unknown>,
  input: TransitionComfyGenerationRequestInput,
) {
  if (input.expectedLeaseId === undefined) return true
  if (current.leaseId === input.expectedLeaseId) return true
  const clearsLease = input.to === 'waiting_capacity'
    && input.patch?.connectionId === null
    && input.patch.leaseId === null
    && input.patch.leaseExpiresAt === null
  return clearsLease && current.lastTransitionToken === input.expectedLeaseId
}

function validPatchValue(key: string, value: unknown) {
  if (['connectionId', 'leaseId', 'promptId', 'clientId', 'errorCode', 'errorMessage']
    .includes(key)) return value === null || typeof value === 'string'
  if (key === 'leaseExpiresAt') return value === null || value instanceof Date
  return value === null || typeof value === 'object'
}

function patchMatches(current: Record<string, unknown>, patch: ComfyTransitionPatch | undefined) {
  return Object.entries(patch ?? {}).every(([key, value]) => equalValue(current[key], value))
}

function equalValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  return JSON.stringify(left) === JSON.stringify(right)
}

function sanitizeVariableSnapshot(
  variables: Record<string, ComfyVariableValue>,
  rawDefinitions: unknown,
) {
  if (!isBoundedLiveVariables(variables) || !Array.isArray(rawDefinitions)) {
    throw new ApiError('INVALID_PARAMS')
  }
  const definitions = new Map<string, ComfyVariableDefinition>()
  for (const rawDefinition of rawDefinitions) {
    if (!isVariableDefinition(rawDefinition) || definitions.has(rawDefinition.name)) {
      throw new ApiError('INVALID_PARAMS')
    }
    definitions.set(rawDefinition.name, rawDefinition)
  }
  if (Object.keys(variables).some((name) => !definitions.has(name))) {
    throw new ApiError('INVALID_PARAMS')
  }
  const snapshot: Record<string, ComfyVariableValue> = {}
  for (const definition of definitions.values()) {
    const supplied = Object.hasOwn(variables, definition.name)
    const value = supplied ? variables[definition.name] : definition.defaultValue
    if (!supplied && definition.required) throw new ApiError('INVALID_PARAMS')
    if (value === undefined) continue
    if (!matchesComfyVariableType(value, definition.type)) throw new ApiError('INVALID_PARAMS')
    snapshot[definition.name] = sanitizeVariableValue(value, definition.type)
  }
  if (!isBoundedLiveVariables(snapshot)) throw new ApiError('INVALID_PARAMS')
  return snapshot
}

function isVariableDefinition(value: unknown): value is ComfyVariableDefinition {
  return isRecord(value) && typeof value.name === 'string'
    && ['string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref']
      .includes(String(value.type))
    && typeof value.required === 'boolean'
}

function sanitizeVariableValue(
  value: ComfyVariableValue,
  type: ComfyVariableDefinition['type'],
): ComfyVariableValue {
  if (type === 'image_ref_list') {
    return (value as ComfyMediaRef[]).map(sanitizeMediaRef)
  }
  if (type === 'image_ref' || type === 'video_ref') {
    return sanitizeMediaRef(value as ComfyMediaRef)
  }
  return value
}

function sanitizeMediaRef(value: ComfyMediaRef) {
  return {
    storageKey: value.storageKey,
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
  }
}

function phaseTimestamp(status: ComfyRequestStatus, now: Date) {
  const field: Partial<Record<ComfyRequestStatus, string>> = {
    leased: 'leasedAt', uploading: 'uploadingAt', submitted: 'submittedAt',
    running: 'runningAt', transferring: 'transferringAt', reconciling: 'reconcilingAt',
    completed: 'completedAt', failed: 'failedAt', canceled: 'canceledAt',
  }
  return field[status] ? { [field[status]!]: now } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isPrismaCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code
}
