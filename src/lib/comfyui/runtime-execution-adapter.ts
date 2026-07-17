import type { ComfyConnection, ComfyGenerationRequest, ComfyWorkflowVersion } from '@prisma/client'

import { decryptApiKey } from '@/lib/crypto-utils'
import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { getObjectBuffer, getSignedUrl, uploadObject } from '@/lib/storage'

import { ComfyClient } from './client'
import { checkComfyCompatibility, type ComfyCompatibilityClient } from './compatibility'
import {
  findComfyPromptByClientId,
  type ComfyDispatcherDependencies,
  type ComfyReconciliationDependencies,
} from './dispatcher'
import { COMFY_ERROR_CODE, ComfyError } from './errors'
import {
  comfyRequestLeaseValue,
  heartbeatDurableComfyRequestLease,
  releaseComfyRequestLease,
} from './lease'
import { resolveOwnedComfyMedia } from './media-ownership'
import {
  claimComfySubmissionFenceWithStore,
  persistComfyOutputReceiptWithStore,
  recordComfyAcceptedPromptWithStore,
  recordComfyAttemptAbsenceWithStore,
} from './submission'
import { comfyLeaseKey } from './test-lease'
import type {
  ComfyConnectionAuth,
  ComfyApiWorkflow,
  ComfyInputBinding,
  ComfyOutputBinding,
  ComfyOutputRef,
  ComfyRequestStatus,
  ComfyStoredOutputRef,
  ComfyVariableDefinition,
  ComfyVariableValue,
  ComfyWorkflowRequirements,
  ComfyWorkflowPurpose,
} from './types'
import type { ComfyRuntimeOperationLimits } from './runtime-deps'

type Bundle = ComfyGenerationRequest & {
  connection: ComfyConnection | null
  workflowVersion: ComfyWorkflowVersion
  submissionAttempts: Array<{
    id: string
    clientId: string
    promptId: string | null
  }>
}

export async function createProductionDispatcherDependencies(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  signal: AbortSignal,
  executionFence: () => Promise<boolean> = async () => true,
  sharedRequestHeartbeat?: () => Promise<boolean>,
): Promise<ComfyDispatcherDependencies> {
  const { bundle, client, context } = await loadRuntimeContext(requestId, limits)
  const owner = ownerOf(bundle)
  const ownerWhere = () => ({
    id: owner.requestId, userId: owner.userId, connectionId: owner.connectionId,
    leaseId: owner.leaseId,
  })
  const executionOwned = async () => await executionFence() && await verifyOwner(owner)
  const updateOwned = async (
    where: Record<string, unknown>, data: Record<string, unknown>,
  ) => await executionFence() && (await prisma.comfyGenerationRequest.updateMany({
      where: { ...ownerWhere(), ...where }, data,
    })).count === 1

  return {
    loadContext: async () => context,
    recheckClaim: executionOwned,
    heartbeat: async (input) => await executionFence()
      && (sharedRequestHeartbeat
        ? await sharedRequestHeartbeat()
        : (await heartbeatDurableComfyRequestLease(input)).owned),
    release: async (input) => await executionFence() && await releaseComfyRequestLease(input),
    transition: ({ from, to }) => updateOwned(
      { status: from }, { status: to, ...timestampFor(to) },
    ),
    preSubmitGate: (freshContext) => runFreshComfyPreSubmitGate({
      connectionId: owner.connectionId,
      workflowHash: freshContext.version.contentHash ?? '',
      graph: freshContext.version.graph ?? {},
      requirements: freshContext.version.requirements ?? {
        nodeClasses: [], candidateLoaderInputs: [],
      },
      client,
      connectionState: () => readFreshConnectionState(owner, bundle.connection!),
      verifyOwner: async () => await executionFence()
        && await verifyFreshConnectionOwner(owner, bundle.connection!),
    }),
    blockIncompatible: () => updateOwned({
      status: { in: ['leased', 'uploading'] }, promptId: null,
    }, {
      status: 'blocked_no_compatible_instance', connectionId: null,
      leaseId: null, leaseExpiresAt: null,
      errorCode: COMFY_ERROR_CODE.WORKFLOW_INCOMPATIBLE,
    }),
    claimSubmissionFence: async (input) => await executionFence()
      ? claimComfySubmissionFenceWithStore(input) : { outcome: 'lost' },
    recordAcceptedPrompt: async (input) => await executionFence()
      ? recordComfyAcceptedPromptWithStore(input) : { outcome: 'attempt_recorded' },
    cancelIfRequested: async ({ promptId }) => {
      const canceled = await prisma.comfyGenerationRequest.findFirst({
        where: { ...ownerWhere(), promptId, cancelRequestedAt: { not: null } },
        select: { id: true },
      })
      if (!canceled) return 'continue'
      return cancelAcceptedPromptSafely({
        promptId,
        getQueue: () => client.getQueue(),
        deleteQueuedPrompt: (id) => client.deleteQueuedPrompt(id),
        verifyOwner: executionOwned,
        persistCanceled: () => updateOwned({
          promptId, cancelRequestedAt: { not: null },
          status: { notIn: ['completed', 'failed', 'canceled'] },
        }, { status: 'canceled', canceledAt: new Date() }),
        persistReconciling: () => updateOwned({
          promptId, cancelRequestedAt: { not: null },
          status: { notIn: ['completed', 'failed', 'canceled'] },
        }, {
          status: 'reconciling', reconcilingAt: new Date(),
          errorCode: COMFY_ERROR_CODE.RECONCILIATION_REQUIRED,
        }),
      })
    },
    cancelBeforeTransfer: ({ promptId }) => updateOwned({
      status: { in: ['transferring', 'reconciling'] },
      cancelRequestedAt: { not: null }, ...(promptId ? { promptId } : {}),
    }, { status: 'canceled', canceledAt: new Date() }),
    persistProgress: ({ promptId }) => updateOwned({
      promptId, status: { in: ['submitted', 'running'] }, cancelRequestedAt: null,
    }, {
      status: 'running', runningAt: new Date(),
    }),
    persistOutputRefs: ({ promptId, outputs }) => updateOwned({
      promptId, status: { in: ['submitted', 'running', 'reconciling'] },
      cancelRequestedAt: null,
    }, { status: 'transferring', transferringAt: new Date(), outputRefs: outputs }),
    persistCompletedOutputs: ({ promptId, outputs }) => updateOwned({
      promptId, status: { in: ['transferring', 'reconciling'] },
      cancelRequestedAt: null,
    }, { status: 'completed', completedAt: new Date(), outputRefs: outputs }),
    persistStoredOutputReceipt: async (input) => await executionFence()
      && await persistComfyOutputReceiptWithStore(input),
    returnToWaiting: ({ errorCode }) => updateOwned({
      status: { in: ['leased', 'uploading'] }, promptId: null,
    }, {
      status: 'waiting_capacity', connectionId: null, leaseId: null,
      leaseExpiresAt: null, errorCode: errorCode ?? null,
    }),
    markReconciling: ({ promptId, errorCode }) => updateOwned({
      status: { notIn: ['completed', 'failed', 'canceled'] },
    }, { status: 'reconciling', reconcilingAt: new Date(), promptId, errorCode }),
    markFailed: ({ promptId, errorCode, errorMessage }) => updateOwned({
      status: { notIn: ['completed', 'failed', 'canceled'] },
      ...(promptId ? { promptId } : {}),
    }, { status: 'failed', failedAt: new Date(), errorCode, errorMessage }),
    client,
    signal,
    startExecutionTimeout: () => createExecutionDeadline(signal, limits.executionTimeoutMs),
    leaseTtlMs: limits.leaseTtlMs,
    maxInputBytes: limits.inputMaxBytes,
    maxOutputBytes: limits.outputMaxBytes,
    resolveOwnedMedia: (input) => resolveOwnedComfyMedia(input),
    verifyExternalEffect: executionOwned,
    readOwnedObject: async ({ storageKey, maxBytes }) => {
      const bytes = await getObjectBuffer(storageKey)
      if (bytes.byteLength > Math.min(maxBytes, limits.inputMaxBytes)) {
        throw new ComfyError(
          COMFY_ERROR_CODE.INPUT_UPLOAD_FAILED,
          'ComfyUI input exceeds configured limit',
          { retryable: false },
        )
      }
      return bytes
    },
    uploadObject,
    objectExists: async () => false,
    resolveStoredUrl: (key) => getSignedUrl(key),
  }
}

export async function cancelAcceptedPromptSafely(input: {
  promptId: string
  getQueue(): Promise<{ running: unknown[]; pending: unknown[] }>
  deleteQueuedPrompt(promptId: string): Promise<void>
  verifyOwner(): Promise<boolean>
  persistCanceled(): Promise<boolean>
  persistReconciling(): Promise<boolean>
}): Promise<'canceled' | 'reconciling'> {
  const queue = await input.getQueue()
  if (!await input.verifyOwner()) return 'reconciling'
  if (queueContains(queue.running, input.promptId)) {
    await input.persistReconciling()
    return 'reconciling'
  }
  if (!queueContains(queue.pending, input.promptId)) {
    await input.persistReconciling()
    return 'reconciling'
  }
  const confirmed = await input.getQueue()
  if (!await input.verifyOwner()
    || !queueContains(confirmed.pending, input.promptId)
    || queueContains(confirmed.running, input.promptId)) {
    await input.persistReconciling()
    return 'reconciling'
  }
  await input.deleteQueuedPrompt(input.promptId)
  const afterDelete = await input.getQueue()
  if (queueContains(afterDelete.pending, input.promptId)
    || queueContains(afterDelete.running, input.promptId)) {
    await input.persistReconciling()
    return 'reconciling'
  }
  return await input.persistCanceled() ? 'canceled' : 'reconciling'
}

export async function createProductionReconciliationDependencies(
  requestId: string,
  limits: ComfyRuntimeOperationLimits,
  reconciliationFence: () => Promise<boolean> = async () => true,
): Promise<ComfyReconciliationDependencies> {
  const { bundle, client, context } = await loadRuntimeContext(requestId, limits)
  const owner = ownerOf(bundle)
  const ownerWhere = {
    id: owner.requestId, userId: owner.userId, connectionId: owner.connectionId,
    leaseId: owner.leaseId,
  }
  const updateOwned = async (data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    if (!await reconciliationFence()) return false
    return (await prisma.comfyGenerationRequest.updateMany({
      where: { ...ownerWhere, ...extra }, data,
    })).count === 1
  }

  return {
    loadContext: async () => context,
    verifyLeaseOwner: async (input) => await reconciliationFence() && await verifyOwner(input),
    getQueue: () => client.getQueue(),
    getHistory: (promptId) => client.getHistory(promptId),
    findPromptByClientId: async (clientId) => findComfyPromptByClientId(
      await client.getQueue(), await client.getHistoryAll(), clientId,
    ),
    persistDiscoveredPrompt: async ({ attemptId, clientId, promptId }) => {
      if (!await reconciliationFence()) return false
      const receipt = await recordComfyAcceptedPromptWithStore({
        ...owner, attemptId, clientId, promptId,
      })
      return receipt.outcome === 'request_recorded' || receipt.outcome === 'attempt_recorded'
    },
    recordAttemptAbsence: async (input) => {
      if (!await reconciliationFence()) throw new Error('Reconciliation ownership lost')
      return recordComfyAttemptAbsenceWithStore({
        ...input, now: new Date(),
        policy: { minChecks: 3, minAgeMs: 5_000, deadlineMs: limits.executionTimeoutMs },
      })
    },
    deleteQueuedPrompt: async (promptId) => {
      if (!await reconciliationFence() || !await verifyOwner(owner)) {
        throw new Error('Reconciliation ownership lost')
      }
      await client.deleteQueuedPrompt(promptId)
    },
    persistRecoveredCancellation: ({ promptId }) => updateOwned(
      { status: 'canceled', canceledAt: new Date() },
      { promptId, cancelRequestedAt: { not: null }, status: { notIn: ['completed', 'failed', 'canceled'] } },
    ),
    persistRecoveredDiagnostics: ({ promptId, outputs, errorCode }) => updateOwned({
      ...(outputs ? { outputRefs: outputs } : {}), ...(errorCode ? { errorCode } : {}),
    }, { promptId, status: { notIn: ['completed', 'failed', 'canceled'] } }),
    releaseLease: async (input) => await reconciliationFence()
      && await releaseComfyRequestLease({ ...input, ttlMs: 1 }),
    isAbsenceConclusive: async () => Date.now() - bundle.updatedAt.getTime() >= limits.executionTimeoutMs,
    persistRecoveredState: ({ promptId, status, outputs, errorCode }) => updateOwned({
      status, ...timestampFor(status), ...(outputs ? { outputRefs: outputs } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(status === 'failed' ? { errorMessage: 'ComfyUI reconciliation failed' } : {}),
    }, { promptId, status: { notIn: ['completed', 'failed', 'canceled'] } }),
  }
}

async function loadRuntimeContext(requestId: string, limits: ComfyRuntimeOperationLimits) {
  const bundle = await prisma.comfyGenerationRequest.findUnique({
    where: { id: requestId },
    include: {
      connection: true,
      workflowVersion: true,
      submissionAttempts: {
        orderBy: { createdAt: 'desc' }, take: 1,
        select: { id: true, clientId: true, promptId: true },
      },
    },
  }) as Bundle | null
  if (!bundle?.connection || !bundle.leaseId) throw new Error('Invalid ComfyUI runtime request')
  const client = createProductionComfyClient(bundle.connection, limits)
  const version = bundle.workflowVersion
  const context = {
    request: {
      ...bundle,
      mediaType: mediaType(bundle.mediaType),
      status: bundle.status as ComfyRequestStatus,
      variableSnapshot: bundle.variableSnapshot as Record<string, ComfyVariableValue>,
      outputRefs: bundle.outputRefs as Array<ComfyOutputRef | ComfyStoredOutputRef> | null,
      submissionAttempt: bundle.submissionAttempts[0] ?? null,
    },
    connection: { id: bundle.connection.id, userId: bundle.connection.userId, enabled: bundle.connection.enabled },
    version: {
      id: version.id, workflowId: version.workflowId,
      purpose: (version.purpose ?? 'generation') as ComfyWorkflowPurpose,
      graph: version.apiFormatJson as never,
      variableDefinitions: version.variableDefinitions as unknown as ComfyVariableDefinition[],
      bindings: version.bindingSpec as unknown as ComfyInputBinding[],
      outputs: version.outputSpec as unknown as ComfyOutputBinding[],
      requirements: version.requirements as unknown as ComfyWorkflowRequirements,
      contentHash: version.contentHash,
    },
  }
  return { bundle, client, context }
}

export function createProductionComfyClient(
  connection: ComfyConnection,
  limits: ComfyRuntimeOperationLimits,
) {
  return new ComfyClient({
    baseUrl: connection.normalizedBaseUrl,
    auth: decodeAuth(connection),
    networkPolicy: limits.networkPolicy,
    timeoutMs: Math.min(limits.executionTimeoutMs, 30_000),
    outputTimeoutMs: limits.executionTimeoutMs,
    wsIdleTimeoutMs: limits.executionTimeoutMs,
    maxWorkflowBytes: limits.workflowMaxBytes,
    maxInputBytes: limits.inputMaxBytes,
    maxOutputBytes: limits.outputMaxBytes,
  })
}

export async function runFreshComfyPreSubmitGate(input: {
  connectionId: string
  workflowHash: string
  graph: ComfyApiWorkflow
  requirements: ComfyWorkflowRequirements
  client: ComfyCompatibilityClient & {
    getSystemStats(): Promise<unknown>
    getQueue(): Promise<{ running: unknown[]; pending: unknown[] }>
  }
  verifyOwner(): Promise<boolean>
  connectionState?(): Promise<'enabled' | 'disabled' | 'changed'>
}): Promise<'ready' | 'external_busy' | 'incompatible' | 'disabled' | 'lost'> {
  const initialState = await input.connectionState?.()
  if (initialState === 'disabled') return 'disabled'
  if (initialState === 'changed') return 'lost'
  await input.client.getSystemStats()
  const queue = await input.client.getQueue()
  if (queue.running.length > 0 || queue.pending.length > 0) {
    return await input.verifyOwner() ? 'external_busy' : 'lost'
  }
  const compatibility = await checkComfyCompatibility({
    connectionId: input.connectionId,
    workflowHash: input.workflowHash,
    graph: input.graph,
    requirements: input.requirements,
    client: input.client,
  })
  const finalQueue = await input.client.getQueue()
  if (finalQueue.running.length > 0 || finalQueue.pending.length > 0) {
    return await input.verifyOwner() ? 'external_busy' : 'lost'
  }
  const finalState = await input.connectionState?.()
  if (finalState === 'disabled') return 'disabled'
  if (finalState === 'changed') return 'lost'
  if (!await input.verifyOwner()) return 'lost'
  return compatibility.compatible ? 'ready' : 'incompatible'
}

async function verifyOwner(input: {
  requestId: string; userId: string; connectionId: string; leaseId: string
}) {
  const [lease, count] = await Promise.all([
    redis.get(comfyLeaseKey(input.connectionId)),
    prisma.comfyGenerationRequest.count({
      where: {
        id: input.requestId, userId: input.userId, connectionId: input.connectionId,
        leaseId: input.leaseId,
        status: { in: ['leased', 'uploading', 'submitting', 'submitted', 'running', 'transferring', 'reconciling'] },
      },
    }),
  ])
  return count === 1 && lease === comfyRequestLeaseValue(input)
}

async function verifyFreshConnectionOwner(
  input: { requestId: string; userId: string; connectionId: string; leaseId: string },
  snapshot: ComfyConnection,
) {
  const [owned, connection] = await Promise.all([
    verifyOwner(input),
    prisma.comfyConnection.findFirst({
      where: { id: input.connectionId, userId: input.userId },
      select: {
        enabled: true, normalizedBaseUrl: true, authType: true, authSecretEncrypted: true,
      },
    }),
  ])
  return owned && !!connection && connection.enabled
    && connection.normalizedBaseUrl === snapshot.normalizedBaseUrl
    && connection.authType === snapshot.authType
    && connection.authSecretEncrypted === snapshot.authSecretEncrypted
}

async function readFreshConnectionState(
  input: { userId: string; connectionId: string },
  snapshot: ComfyConnection,
): Promise<'enabled' | 'disabled' | 'changed'> {
  const connection = await prisma.comfyConnection.findFirst({
    where: { id: input.connectionId, userId: input.userId },
    select: {
      enabled: true, normalizedBaseUrl: true, authType: true, authSecretEncrypted: true,
    },
  })
  if (!connection
    || connection.normalizedBaseUrl !== snapshot.normalizedBaseUrl
    || connection.authType !== snapshot.authType
    || connection.authSecretEncrypted !== snapshot.authSecretEncrypted) return 'changed'
  return connection.enabled ? 'enabled' : 'disabled'
}

function ownerOf(bundle: Bundle) {
  if (!bundle.connectionId || !bundle.leaseId) throw new Error('Invalid ComfyUI request owner')
  return {
    requestId: bundle.id, userId: bundle.userId,
    connectionId: bundle.connectionId, leaseId: bundle.leaseId,
  }
}

function decodeAuth(connection: ComfyConnection): ComfyConnectionAuth {
  if (connection.authType === 'none') return { type: 'none' }
  if (!connection.authSecretEncrypted) throw new Error('Missing ComfyUI credentials')
  let value: unknown
  try { value = JSON.parse(decryptApiKey(connection.authSecretEncrypted)) } catch {
    throw new Error('Invalid ComfyUI credentials')
  }
  if (connection.authType === 'bearer' && isRecord(value) && typeof value.token === 'string') {
    return { type: 'bearer', token: value.token }
  }
  if (connection.authType === 'basic' && isRecord(value)
    && typeof value.username === 'string' && typeof value.password === 'string') {
    return { type: 'basic', username: value.username, password: value.password }
  }
  throw new Error('Invalid ComfyUI credentials')
}

function timestampFor(status: ComfyRequestStatus) {
  const field = `${status}At`
  return ['leasedAt', 'uploadingAt', 'submittingAt', 'submittedAt', 'runningAt',
    'transferringAt', 'reconcilingAt', 'completedAt', 'failedAt', 'canceledAt'].includes(field)
    ? { [field]: new Date() }
    : {}
}

function createExecutionDeadline(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  timer.unref?.()
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
    parent.removeEventListener('abort', abort)
  }, { once: true })
  let disposed = false
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

function mediaType(value: string): 'image' | 'video' {
  if (value !== 'image' && value !== 'video') throw new Error('Invalid ComfyUI media type')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function queueContains(entries: unknown[], promptId: string) {
  return entries.some((entry) => Array.isArray(entry) && entry[1] === promptId)
}
