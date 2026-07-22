import { Prisma } from '@prisma/client'

import { ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'

import {
  COMFY_REFERENCE_UPLOAD_LIMIT,
  COMFY_REQUEST_STATUS,
  type ComfyMediaType,
  type ComfyMediaRef,
  type ComfyRequestStatus,
  type ComfyVariableValue,
  type ComfyVariableDefinition,
  type ComfyApiWorkflow,
  type ComfyInputBinding,
} from './types'
import { isBoundedLiveVariables } from './workflow-limits'
import { matchesComfyVariableType } from './workflow-schema'
import { isOpaqueStorageKey } from './media'
import {
  resolveOwnedComfyMedia,
  type OwnedComfyMediaInput,
} from './media-ownership'
import { resolveComfyDimensionsForAspectRatio } from './aspect-ratio'
import { canonicalDurationDefinition } from './duration-contract'
import { augmentLtxDirectorContract } from './ltx-director-contract'

export const ALLOWED_COMFY_REQUEST_TRANSITIONS: Record<
  ComfyRequestStatus,
  readonly ComfyRequestStatus[]
> = {
  waiting_capacity: ['blocked_no_compatible_instance', 'leased', 'canceled'],
  blocked_no_compatible_instance: ['waiting_capacity', 'canceled'],
  leased: ['uploading', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  uploading: ['submitting', 'waiting_capacity', 'reconciling', 'failed', 'canceled'],
  submitting: ['submitted', 'reconciling', 'failed', 'canceled'],
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
  workflowVersionId?: string
  variables: Record<string, ComfyVariableValue>
}

interface RequestCreateOperations {
  findInvocation(invocationKey: string, userId: string): Promise<Record<string, unknown> | null>
  findPublishedWorkflow(input: {
    id: string
    userId: string
    mediaType: ComfyMediaType
  }): Promise<Record<string, unknown> | null>
  findPublishedVersion?(input: {
    id: string
    workflowId: string
    requireSuccessfulTest: boolean
  }): Promise<Record<string, unknown> | null>
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
  resolveOwnedMedia?(input: OwnedComfyMediaInput): Promise<boolean>
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
  findPublishedVersion: ({ id, workflowId, requireSuccessfulTest }) => prisma.comfyWorkflowVersion.findFirst({
    where: {
      id, workflowId, publishedAt: { not: null },
      ...(requireSuccessfulTest ? { lastSuccessfulTestAt: { not: null } } : {}),
    },
  }),
  create: (data) => prisma.comfyGenerationRequest.create({
    data: data as Prisma.ComfyGenerationRequestUncheckedCreateInput,
  }),
  resolveOwnedMedia: (input) => resolveOwnedComfyMedia(input),
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
    findPublishedVersion: ({ id, workflowId, requireSuccessfulTest }) => tx.comfyWorkflowVersion.findFirst({
      where: {
        id, workflowId, publishedAt: { not: null },
        ...(requireSuccessfulTest ? { lastSuccessfulTestAt: { not: null } } : {}),
      },
    }),
    create: (data) => tx.comfyGenerationRequest.create({
      data: data as Prisma.ComfyGenerationRequestUncheckedCreateInput,
    }),
    resolveOwnedMedia: (input) => resolveOwnedComfyMedia(input, {
      findFirst: (args) => tx.mediaObject.findFirst(args as Prisma.MediaObjectFindFirstArgs),
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
      if (!isRecord(workflow) || typeof workflow.id !== 'string') {
        throw new ApiError('NOT_FOUND')
      }
      const selectedVersion = input.workflowVersionId
        ? await client.findPublishedVersion?.({
          id: input.workflowVersionId,
          workflowId: workflow.id,
          requireSuccessfulTest: false,
        })
        : currentVersion
      if (!isRecord(selectedVersion)
        || selectedVersion.workflowId !== workflow.id || !selectedVersion.publishedAt
        || (input.workflowVersionId
          ? selectedVersion.id !== input.workflowVersionId
          : workflow.currentVersionId === null || selectedVersion.id !== workflow.currentVersionId)) {
        throw new ApiError('NOT_FOUND')
      }
      const runtimeContract = augmentLtxDirectorContract({
        graph: selectedVersion.apiFormatJson as ComfyApiWorkflow,
        variableDefinitions: Array.isArray(selectedVersion.variableDefinitions)
          ? selectedVersion.variableDefinitions as ComfyVariableDefinition[]
          : [],
        bindings: Array.isArray(selectedVersion.bindingSpec)
          ? selectedVersion.bindingSpec as ComfyInputBinding[]
          : [],
      })
      const normalizedVariables = normalizeSystemVariables(
        input.variables,
        runtimeContract.variableDefinitions,
      )
      const variableSnapshot = await sanitizeVariableSnapshot(
        normalizedVariables, runtimeContract.variableDefinitions, input.userId, input.projectId,
        client.resolveOwnedMedia,
      )
      return client.create({
        invocationKey: input.invocationKey,
        userId: input.userId,
        projectId: input.projectId,
        taskId: input.taskId,
        mediaType: input.mediaType,
        workflowId: workflow.id,
        workflowVersionId: selectedVersion.id,
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

function normalizeSystemVariables(
  variables: Record<string, ComfyVariableValue>,
  rawDefinitions: unknown,
): Record<string, ComfyVariableValue> {
  if (!Array.isArray(rawDefinitions)) throw new ApiError('INVALID_PARAMS')
  const definitions = rawDefinitions.filter((definition): definition is Record<string, unknown> => (
    isRecord(definition) && typeof definition.name === 'string'
  ))
  const names = new Set(definitions.map((definition) => definition.name as string))
  const normalized: Record<string, ComfyVariableValue> = { ...variables }
  // Prompt is a system convenience input, but image upscale workflows often
  // consist of only sourceImage -> image output. Do not reject those workflows
  // merely because the generic image generator supplied a prompt.
  if (!names.has('prompt')) delete normalized.prompt
  normalizeSystemAlias({
    normalized, names, legacy: 'input_images', canonical: 'referenceImages',
  })
  normalizeSystemDuration(normalized, names, definitions as unknown as ComfyVariableDefinition[])
  normalizeSystemFirstFrame(normalized, names)
  normalizeSystemAlias({
    normalized, names, legacy: 'last_frame', canonical: 'lastFrame',
    undeclaredBindingError: {
      code: 'COMFY_LAST_FRAME_BINDING_REQUIRED',
      field: 'lastFrame',
    },
  })
  if (!names.has('fps')) delete normalized.fps
  const aspectDefinition = definitions.find((definition) => (
    String(definition.name).replace(/[-_]/g, '').toLowerCase() === 'aspectratio'
  ))
  if (Object.hasOwn(normalized, 'aspect_ratio') && aspectDefinition) {
    const aspectVariableName = aspectDefinition.name as string
    if (aspectVariableName !== 'aspect_ratio') {
      if (Object.hasOwn(normalized, aspectVariableName)) throw new ApiError('INVALID_PARAMS')
      normalized[aspectVariableName] = normalized.aspect_ratio
      delete normalized.aspect_ratio
    }
  } else if (Object.hasOwn(normalized, 'aspect_ratio')) {
    const widthDefinition = definitions.find((definition) => (
      String(definition.name).replace(/[-_]/g, '').toLowerCase() === 'width'
      && definition.type === 'number'
    ))
    const heightDefinition = definitions.find((definition) => (
      String(definition.name).replace(/[-_]/g, '').toLowerCase() === 'height'
      && definition.type === 'number'
    ))
    const dimensions = widthDefinition && heightDefinition
      ? resolveComfyDimensionsForAspectRatio({
          aspectRatio: normalized.aspect_ratio,
          defaultWidth: widthDefinition.defaultValue,
          defaultHeight: heightDefinition.defaultValue,
        })
      : null
    delete normalized.aspect_ratio
    if (dimensions && widthDefinition && heightDefinition) {
      const widthVariableName = widthDefinition.name as string
      const heightVariableName = heightDefinition.name as string
      if (!Object.hasOwn(normalized, widthVariableName) && !Object.hasOwn(normalized, heightVariableName)) {
        normalized[widthVariableName] = dimensions.width
        normalized[heightVariableName] = dimensions.height
      }
    }
  }
  return normalized
}

function normalizeSystemAlias(input: {
  normalized: Record<string, ComfyVariableValue>
  names: Set<string>
  legacy: string
  canonical: string
  undeclaredBindingError?: { code: string; field: string }
}) {
  const declaresLegacy = input.names.has(input.legacy)
  const declaresCanonical = input.names.has(input.canonical)
  if (declaresLegacy && declaresCanonical) throw new ApiError('INVALID_PARAMS')

  const hasLegacy = Object.hasOwn(input.normalized, input.legacy)
  const hasCanonical = Object.hasOwn(input.normalized, input.canonical)
  if (hasLegacy && hasCanonical) throw new ApiError('INVALID_PARAMS')

  if (declaresCanonical && hasLegacy) {
    input.normalized[input.canonical] = input.normalized[input.legacy]
    delete input.normalized[input.legacy]
    return
  }
  if (!declaresLegacy && !declaresCanonical && hasLegacy && input.undeclaredBindingError) {
    throw new ApiError('INVALID_PARAMS', {
      code: input.undeclaredBindingError.code,
      field: input.undeclaredBindingError.field,
      message: input.undeclaredBindingError.code,
    })
  }
}

function normalizeSystemFirstFrame(
  normalized: Record<string, ComfyVariableValue>,
  names: Set<string>,
) {
  const declaresGuidedFirstFrame = names.has('firstFrame') || names.has('first_frame')
  if (!declaresGuidedFirstFrame && names.has('sourceImage') && Object.hasOwn(normalized, 'first_frame')) {
    if (Object.hasOwn(normalized, 'sourceImage')) throw new ApiError('INVALID_PARAMS')
    normalized.sourceImage = normalized.first_frame
    delete normalized.first_frame
    return
  }
  normalizeSystemAlias({
    normalized, names, legacy: 'first_frame', canonical: 'firstFrame',
    undeclaredBindingError: {
      code: 'COMFY_FIRST_FRAME_BINDING_REQUIRED',
      field: 'firstFrame',
    },
  })
}

function normalizeSystemDuration(
  normalized: Record<string, ComfyVariableValue>,
  names: Set<string>,
  definitions: readonly ComfyVariableDefinition[],
) {
  if (names.has('duration') && names.has('duration_seconds')) {
    throw new ApiError('INVALID_PARAMS')
  }
  const durationDefinition = canonicalDurationDefinition(definitions)
  const target = durationDefinition?.name
  if (!target) {
    if (Object.hasOwn(normalized, 'duration_seconds')) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'COMFY_DURATION_BINDING_REQUIRED',
        field: 'duration',
        message: 'COMFY_DURATION_BINDING_REQUIRED',
      })
    }
    return
  }
  if (target === 'duration_seconds') return
  const hasSystemDuration = Object.hasOwn(normalized, 'duration_seconds')
  if (!hasSystemDuration) return
  if (Object.hasOwn(normalized, target)) throw new ApiError('INVALID_PARAMS')
  normalized[target] = normalized.duration_seconds
  delete normalized.duration_seconds
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
  submitting: ['clientId'],
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
  'submitting',
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

async function sanitizeVariableSnapshot(
  variables: Record<string, ComfyVariableValue>,
  rawDefinitions: unknown,
  userId: string,
  projectId: string,
  resolveOwnedMedia: RequestCreateOperations['resolveOwnedMedia'],
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
    if (
      definition.type === 'image_ref_list'
      && definition.maxItems !== undefined
      && (value as ComfyMediaRef[]).length > definition.maxItems
    ) {
      throw new ApiError('INVALID_PARAMS', {
        reason: 'COMFY_REFERENCE_CAPACITY_EXCEEDED',
        variable: definition.name,
        maxItems: definition.maxItems,
      })
    }
    snapshot[definition.name] = await sanitizeVariableValue(
      value, definition.name, definition.type, userId, projectId, resolveOwnedMedia,
    )
  }
  if (!isBoundedLiveVariables(snapshot)) throw new ApiError('INVALID_PARAMS')
  return snapshot
}

function isVariableDefinition(value: unknown): value is ComfyVariableDefinition {
  return isRecord(value) && typeof value.name === 'string'
    && ['string', 'number', 'boolean', 'image_ref', 'image_ref_list', 'video_ref']
      .includes(String(value.type))
    && typeof value.required === 'boolean'
    && (value.maxItems === undefined || (
      value.type === 'image_ref_list'
      && Number.isInteger(value.maxItems)
      && (value.maxItems as number) > 0
      && (value.maxItems as number) <= COMFY_REFERENCE_UPLOAD_LIMIT
    ))
}

async function sanitizeVariableValue(
  value: ComfyVariableValue,
  variableName: string,
  type: ComfyVariableDefinition['type'],
  userId: string,
  projectId: string,
  resolveOwnedMedia: RequestCreateOperations['resolveOwnedMedia'],
): Promise<ComfyVariableValue> {
  if (type === 'image_ref_list') {
    return Promise.all((value as ComfyMediaRef[]).map((ref) => sanitizeMediaRef(
      ref, variableName, userId, projectId, 'image', resolveOwnedMedia,
    )))
  }
  if (type === 'image_ref' || type === 'video_ref') {
    return sanitizeMediaRef(
      value as ComfyMediaRef, variableName, userId, projectId,
      type === 'video_ref' ? 'video' : 'image', resolveOwnedMedia,
    )
  }
  return value
}

async function sanitizeMediaRef(
  value: ComfyMediaRef,
  variableName: string,
  userId: string,
  projectId: string,
  mediaType: ComfyMediaType,
  resolveOwnedMedia: RequestCreateOperations['resolveOwnedMedia'],
) {
  if (!isOpaqueStorageKey(value.storageKey) || !resolveOwnedMedia
    || !await resolveOwnedMedia({ userId, projectId, storageKey: value.storageKey, mediaType })) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'COMFY_MEDIA_NOT_OWNED',
      field: variableName,
      mediaType,
      message: 'COMFY_MEDIA_NOT_OWNED',
    })
  }
  return {
    storageKey: value.storageKey,
    ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.filename === 'string' ? { filename: value.filename } : {}),
  }
}

function phaseTimestamp(status: ComfyRequestStatus, now: Date) {
  const field: Partial<Record<ComfyRequestStatus, string>> = {
    leased: 'leasedAt', uploading: 'uploadingAt', submitting: 'submittingAt', submitted: 'submittedAt',
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
