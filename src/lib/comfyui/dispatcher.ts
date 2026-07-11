import { randomUUID } from 'node:crypto'
import { ApiError } from '@/lib/api-errors'

import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyObservability } from './observability'
import {
  prepareComfyMediaUploads,
  transferComfyOutputs,
  type ComfyMediaClient,
  type ComfyMediaDependencies,
} from './media'
import type {
  ComfyApiWorkflow,
  ComfyExecutionEvent,
  ComfyInputBinding,
  ComfyOutputBinding,
  ComfyOutputRef,
  ComfyRequestStatus,
  ComfyStoredOutputRef,
  ComfyVariableDefinition,
  ComfyVariableValue,
} from './types'
import { extractComfyOutputs } from './workflow-output'
import { renderComfyWorkflow } from './workflow-renderer'
import type { ComfyAcceptedPromptResult, ComfySubmissionFenceResult } from './submission'

export {
  claimComfySubmissionFenceWithStore,
  claimExpiredComfyRequestWithStore,
  reclaimComfyRecoveryLease,
  recordComfyAttemptAbsenceWithStore,
  recordComfyAcceptedPromptWithStore,
} from './submission'

type RequestRecord = {
  id: string
  taskId?: string
  invocationKey?: string
  userId: string
  projectId?: string
  mediaType?: 'image' | 'video'
  workflowId?: string
  workflowVersionId?: string
  variableSnapshot?: Record<string, ComfyVariableValue>
  status: ComfyRequestStatus
  connectionId?: string | null
  leaseId?: string | null
  promptId?: string | null
  clientId?: string | null
  cancelRequestedAt?: Date | null
  outputRefs?: ComfyOutputRef[] | null
  submissionAttempt?: { id: string; clientId: string; promptId?: string | null } | null
}

type ExecutionContext = {
  request: RequestRecord
  connection?: { id: string; userId: string; enabled: boolean }
  version: {
    id?: string
    workflowId?: string
    graph?: ComfyApiWorkflow
    variableDefinitions?: ComfyVariableDefinition[]
    bindings?: ComfyInputBinding[]
    outputs: ComfyOutputBinding[]
  }
}

export interface ComfyExecutionClient extends ComfyMediaClient {
  submitPrompt(graph: ComfyApiWorkflow, clientId: string): Promise<{ promptId: string }>
  watchPrompt(promptId: string, clientId: string, signal: AbortSignal): AsyncIterable<ComfyExecutionEvent>
  getHistory(promptId: string): Promise<Record<string, unknown>>
  getQueue(): Promise<{ running: unknown[]; pending: unknown[] }>
  deleteQueuedPrompt(promptId: string): Promise<void>
  interruptPrompt(promptId: string): Promise<void>
}

type OwnerInput = { requestId: string; userId: string; connectionId: string; leaseId: string }

export interface ComfyDispatcherDependencies extends ComfyMediaDependencies {
  loadContext(requestId: string): Promise<ExecutionContext>
  recheckClaim(context: ExecutionContext, owner: OwnerInput): Promise<boolean>
  heartbeat(owner: OwnerInput & { ttlMs: number }): Promise<boolean>
  release(owner: OwnerInput & { ttlMs: number }): Promise<boolean>
  transition(input: OwnerInput & { from: ComfyRequestStatus; to: ComfyRequestStatus }): Promise<boolean>
  claimSubmissionFence(input: OwnerInput & {
    attemptId: string; clientId: string
  }): Promise<ComfySubmissionFenceResult>
  recordAcceptedPrompt(input: OwnerInput & {
    attemptId: string; clientId: string; promptId: string
  }): Promise<ComfyAcceptedPromptResult>
  cancelIfRequested(input: OwnerInput & { attemptId: string; promptId: string }): Promise<boolean>
  cancelBeforeTransfer(input: OwnerInput & {
    promptId?: string; outputs: ComfyOutputRef[]
  }): Promise<boolean>
  persistProgress(input: OwnerInput & { promptId: string; event: ComfyExecutionEvent; value?: number; max?: number }): Promise<boolean>
  persistOutputRefs(input: OwnerInput & { promptId: string; outputs: ComfyOutputRef[] }): Promise<boolean>
  persistCompletedOutputs(input: OwnerInput & { promptId: string; outputs: ComfyStoredOutputRef[] }): Promise<boolean>
  returnToWaiting(input: OwnerInput & { errorCode: string }): Promise<boolean>
  markReconciling(input: OwnerInput & { promptId: string; errorCode: string }): Promise<boolean>
  markFailed(input: OwnerInput & { promptId?: string; errorCode: string; errorMessage: string }): Promise<boolean>
  client: ComfyExecutionClient
  signal: AbortSignal
  leaseTtlMs: number
  heartbeatTickMs?: number
  randomId?: () => string
  observation?: ComfyObservability
}

export type ComfyDispatchResult =
  | { outcome: 'completed'; primary: ComfyStoredOutputRef; outputs: ComfyStoredOutputRef[] }
  | { outcome: 'waiting_capacity' }
  | { outcome: 'reconciling'; promptId: string }
  | { outcome: 'failed'; code: string }
  | { outcome: 'canceled' }

export async function dispatchComfyRequest(
  requestId: string,
  dependencies: ComfyDispatcherDependencies,
): Promise<ComfyDispatchResult> {
  const context = await dependencies.loadContext(requestId)
  const request = context.request
  const owner = { ...requireOwner(request), ttlMs: dependencies.leaseTtlMs }
  const heartbeat = startHeartbeat(owner, dependencies)
  let promptId = request.promptId ?? undefined
  let submissionAttemptId: string | undefined
  let terminal = false
  try {
    assertContext(context, owner)
    if (!await dependencies.recheckClaim(context, owner)) {
      dependencies.observation?.increment('lease_contention', { outcome: 'claim_recheck' })
      throw lostLease()
    }

    if (request.cancelRequestedAt && request.outputRefs?.length
      && (request.status === 'transferring' || request.status === 'reconciling')) {
      if (await dependencies.cancelBeforeTransfer({
        ...owner, ...(promptId ? { promptId } : {}), outputs: request.outputRefs,
      })) {
        terminal = true
        return { outcome: 'canceled' }
      }
      return { outcome: 'reconciling', promptId: promptId ?? '' }
    }
    if ((request.status === 'transferring' || request.status === 'reconciling')
      && request.outputRefs?.length) {
      const result = await transferAndComplete(context, request.outputRefs, promptId, owner, dependencies)
      terminal = true
      dependencies.observation?.increment('workflow_success', { outcome: 'completed' })
      return result
    }
    if (promptId) {
      await dependencies.markReconciling({ ...owner, promptId, errorCode: COMFY_ERROR_CODE.RECONCILIATION_REQUIRED })
      dependencies.observation?.increment('reconciliation', { outcome: 'recorded_prompt' })
      return { outcome: 'reconciling', promptId }
    }
    if (request.status === 'submitting' || request.clientId) {
      dependencies.observation?.increment('reconciliation', { outcome: 'submission_attempt' })
      return { outcome: 'reconciling', promptId: '' }
    }

    await mustOwn(dependencies.transition({ ...owner, from: request.status, to: 'uploading' }))
    const uploads = await prepareComfyMediaUploads({
      userId: request.userId,
      requestId: request.id,
      variables: request.variableSnapshot ?? {},
      definitions: context.version.variableDefinitions ?? [],
      client: dependencies.client,
      dependencies,
    })
    const graph = renderComfyWorkflow({
      graph: context.version.graph ?? {},
      variables: request.variableSnapshot ?? {},
      variableDefinitions: context.version.variableDefinitions ?? [],
      bindings: context.version.bindings ?? [],
      uploads,
    })
    await heartbeat.assertOwned()
    if (!await dependencies.recheckClaim(context, owner)) {
      dependencies.observation?.increment('lease_contention', { outcome: 'claim_recheck' })
      throw lostLease()
    }
    const clientId = dependencies.randomId?.() ?? randomUUID()
    const attemptId = dependencies.randomId?.() ?? randomUUID()
    const fence = await dependencies.claimSubmissionFence({ ...owner, clientId, attemptId })
    if (fence.outcome === 'canceled') return { outcome: 'canceled' }
    if (fence.outcome !== 'claimed') {
      dependencies.observation?.increment('lease_contention', { outcome: 'submission_fence' })
      return { outcome: 'reconciling', promptId: '' }
    }
    submissionAttemptId = fence.attemptId
    const submission = await dependencies.client.submitPrompt(graph, clientId)
    promptId = submission.promptId
    const receipt = await dependencies.recordAcceptedPrompt({
      ...owner, promptId, clientId, attemptId: fence.attemptId,
    })
    if (receipt.outcome === 'attempt_recorded') {
      dependencies.observation?.increment('reconciliation', { outcome: 'detached_receipt' })
      return { outcome: 'reconciling', promptId }
    }
    if (await dependencies.cancelIfRequested({ ...owner, promptId, attemptId: fence.attemptId })) {
      terminal = true
      return { outcome: 'canceled' }
    }

    const executionStartedAt = Date.now()
    try {
      await consumePromptEvents(
        dependencies.client, promptId, clientId, owner, dependencies,
      )
    } catch (error) {
      if (error instanceof ComfyError && !error.retryable) throw error
      dependencies.observation?.increment('reconciliation', { outcome: 'websocket_fallback' })
    }
    const history = await readCompletedHistory(promptId, dependencies.client)
    dependencies.observation?.observe(
      'execution_duration_ms', Date.now() - executionStartedAt,
      { mediaType: request.mediaType ?? 'image' },
    )
    const outputs = extractComfyOutputs(history, context.version.outputs)
    await heartbeat.assertOwned()
    await mustOwn(dependencies.persistOutputRefs({ ...owner, promptId, outputs }))
    const result = await transferAndComplete(context, outputs, promptId, owner, dependencies)
    terminal = true
    dependencies.observation?.increment('workflow_success', { outcome: 'completed' })
    return result
  } catch (error) {
    if (error instanceof ComfyError && !error.retryable) {
      await dependencies.markFailed({
        ...owner,
        ...(promptId ? { promptId } : {}),
        errorCode: error.code,
        errorMessage: 'ComfyUI operation failed',
      }).catch(() => false)
      dependencies.observation?.increment('failure_code', { code: error.code })
      terminal = true
      return { outcome: 'failed', code: error.code }
    }
    if (promptId) {
      const errorCode = safeErrorCode(error, COMFY_ERROR_CODE.RECONCILIATION_REQUIRED)
      await dependencies.markReconciling({
        ...owner, promptId, errorCode,
      }).catch(() => false)
      dependencies.observation?.increment(
        errorCode === COMFY_ERROR_CODE.OUTPUT_TRANSFER_FAILED ? 'transfer_retry' : 'reconciliation',
        { code: errorCode },
      )
      return { outcome: 'reconciling', promptId }
    }
    if (submissionAttemptId) {
      dependencies.observation?.increment('reconciliation', { outcome: 'uncertain_submission' })
      return { outcome: 'reconciling', promptId: '' }
    }
    const errorCode = safeErrorCode(error, COMFY_ERROR_CODE.CONNECTION_OFFLINE)
    await dependencies.returnToWaiting({
      ...owner, errorCode,
    }).catch(() => false)
    dependencies.observation?.increment('capacity_wait', { code: errorCode })
    terminal = true
    return { outcome: 'waiting_capacity' }
  } finally {
    await heartbeat.stop()
    if (terminal) await dependencies.release(owner).catch(() => false)
  }
}

async function transferAndComplete(
  context: ExecutionContext,
  outputs: ComfyOutputRef[],
  promptId: string | undefined,
  owner: OwnerInput & { ttlMs: number },
  dependencies: ComfyDispatcherDependencies,
) {
  const request = context.request
  const startedAt = Date.now()
  const stored = await transferComfyOutputs({
    userId: request.userId,
    projectId: request.projectId ?? 'unknown',
    requestId: request.id,
    outputs,
    client: dependencies.client,
    dependencies,
  })
  const primary = stored.find((output) => output.primary)
  if (!primary) throw new ComfyError(COMFY_ERROR_CODE.OUTPUT_MISSING, 'Primary output is missing')
  await mustOwn(dependencies.persistCompletedOutputs({
    ...owner, promptId: promptId ?? '', outputs: stored,
  }))
  dependencies.observation?.observe('transfer_duration_ms', Date.now() - startedAt, {
    mediaType: request.mediaType ?? 'image',
  })
  return { outcome: 'completed' as const, primary, outputs: stored }
}

async function consumePromptEvents(
  client: ComfyExecutionClient,
  promptId: string,
  clientId: string,
  owner: OwnerInput & { ttlMs: number },
  dependencies: ComfyDispatcherDependencies,
) {
  let completed = false
  for await (const event of client.watchPrompt(promptId, clientId, dependencies.signal)) {
    if (event.type === 'execution_error') {
      throw new ComfyError(COMFY_ERROR_CODE.EXECUTION_FAILED, 'ComfyUI execution failed')
    }
    if (event.type === 'progress') {
      await mustOwn(dependencies.persistProgress({
        ...owner, promptId, event, value: event.value, max: event.max,
      }))
    } else if (event.type === 'executing' || event.type === 'executed') {
      await mustOwn(dependencies.persistProgress({ ...owner, promptId, event }))
    }
    if (event.type === 'executing' && event.nodeId === null) {
      completed = true
      break
    }
  }
  return completed
}

async function readCompletedHistory(
  promptId: string,
  client: Pick<ComfyExecutionClient, 'getHistory' | 'getQueue'>,
) {
  const history = await client.getHistory(promptId)
  if (hasHistoryEntry(history, promptId) || Object.hasOwn(history, 'outputs')) return history
  const queue = await client.getQueue()
  if (queueContainsPrompt(queue.running, promptId) || queueContainsPrompt(queue.pending, promptId)) {
    throw new ComfyError(COMFY_ERROR_CODE.RECONCILIATION_REQUIRED, 'ComfyUI prompt is still active', { retryable: true })
  }
  throw new ComfyError(
    COMFY_ERROR_CODE.RECONCILIATION_REQUIRED,
    'ComfyUI prompt state is unknown',
    { retryable: true },
  )
}

function startHeartbeat(
  owner: OwnerInput & { ttlMs: number },
  dependencies: Pick<ComfyDispatcherDependencies, 'heartbeat' | 'heartbeatTickMs'>,
) {
  let stopped = false
  let inFlight: Promise<void> | null = null
  let lost = false
  const beat = () => {
    if (stopped || inFlight) return
    inFlight = dependencies.heartbeat(owner).then((owned) => { if (!owned) lost = true }).finally(() => { inFlight = null })
  }
  beat()
  const minimumInterval = Math.max(1, Math.floor(owner.ttlMs / 3))
  const timer = setInterval(beat, Math.max(minimumInterval, dependencies.heartbeatTickMs ?? minimumInterval))
  timer.unref?.()
  return {
    async assertOwned() {
      await inFlight
      if (lost) throw lostLease()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}

export interface ComfyReconciliationDependencies {
  loadContext(requestId: string): Promise<ExecutionContext>
  verifyLeaseOwner(input: OwnerInput): Promise<boolean>
  getQueue(): Promise<{ running: unknown[]; pending: unknown[] }>
  getHistory(promptId: string): Promise<Record<string, unknown>>
  findPromptByClientId?(clientId: string): Promise<string | null>
  persistDiscoveredPrompt?(input: OwnerInput & {
    attemptId: string; clientId: string; promptId: string
  }): Promise<boolean>
  recordAttemptAbsence(input: OwnerInput & {
    attemptId: string; clientId: string
  }): Promise<{ outcome: 'reconciling' | 'failed' | 'canceled'; checkCount: number }>
  deleteQueuedPrompt(promptId: string): Promise<void>
  interruptPrompt(promptId: string): Promise<void>
  persistRecoveredCancellation(input: OwnerInput & { promptId: string }): Promise<boolean>
  persistRecoveredDiagnostics(input: OwnerInput & {
    promptId: string; outputs?: ComfyOutputRef[]; errorCode?: string
  }): Promise<boolean>
  releaseLease(input: OwnerInput): Promise<boolean>
  isAbsenceConclusive?(input: OwnerInput & { promptId: string }): Promise<boolean>
  persistRecoveredState(input: OwnerInput & {
    promptId: string
    status: 'submitted' | 'running' | 'transferring' | 'failed'
    outputs?: ComfyOutputRef[]
    errorCode?: string
  }): Promise<boolean>
}

export async function reconcileComfyRequest(
  requestId: string,
  dependencies: ComfyReconciliationDependencies,
) {
  const context = await dependencies.loadContext(requestId)
  const request = context.request
  const owner = requireOwner(request)
  if (!await dependencies.verifyLeaseOwner(owner)) throw lostLease()
  let promptId = request.promptId ?? request.submissionAttempt?.promptId ?? undefined
  if (!promptId && request.submissionAttempt) {
    promptId = await dependencies.findPromptByClientId?.(request.submissionAttempt.clientId) ?? undefined
    if (!promptId) {
      const absence = await dependencies.recordAttemptAbsence({
        ...owner, attemptId: request.submissionAttempt.id,
        clientId: request.submissionAttempt.clientId,
      })
      if (absence.outcome === 'reconciling') {
        return { outcome: 'reconciling' as const }
      }
      await dependencies.releaseLease(owner).catch(() => false)
      return { outcome: absence.outcome }
    }
    if (!dependencies.persistDiscoveredPrompt
      || !await dependencies.persistDiscoveredPrompt({
        ...owner, attemptId: request.submissionAttempt.id,
        clientId: request.submissionAttempt.clientId, promptId,
      })) throw lostLease()
  }
  if (!promptId) return { outcome: 'reconciling' as const }
  let queue: { running: unknown[]; pending: unknown[] } | undefined
  if (request.cancelRequestedAt) {
    queue = await dependencies.getQueue()
    const queued = queueContainsPrompt(queue.pending, promptId)
    const running = queueContainsPrompt(queue.running, promptId)
    if (queued || running) {
      if (!await dependencies.verifyLeaseOwner(owner)) throw lostLease()
    }
    if (queued) {
      await dependencies.deleteQueuedPrompt(promptId)
    } else if (running) {
      await dependencies.interruptPrompt(promptId)
    } else {
      const cancellationHistory = await dependencies.getHistory(promptId)
      if (historyShowsExecutionFailure(cancellationHistory, promptId)) {
        if (!await dependencies.verifyLeaseOwner(owner)) throw lostLease()
        if (!await dependencies.persistRecoveredDiagnostics({
          ...owner, promptId, errorCode: COMFY_ERROR_CODE.EXECUTION_FAILED,
        })) throw lostLease()
      } else if (hasHistoryEntry(cancellationHistory, promptId)
        || Object.hasOwn(cancellationHistory, 'outputs')) {
        let outputs: ComfyOutputRef[] | undefined
        let extractionCode: string | undefined
        try {
          outputs = extractComfyOutputs(cancellationHistory, context.version.outputs)
        } catch (error) {
          if (!(error instanceof ComfyError)) return { outcome: 'reconciling' as const }
          extractionCode = error.code
        }
        if (!await dependencies.verifyLeaseOwner(owner)) throw lostLease()
        if (!await dependencies.persistRecoveredDiagnostics({
          ...owner, promptId,
          ...(outputs ? { outputs } : {}),
          ...(extractionCode ? { errorCode: extractionCode } : {}),
        })) {
          throw lostLease()
        }
      } else if (!await dependencies.isAbsenceConclusive?.({ ...owner, promptId })) {
        return { outcome: 'reconciling' as const }
      } else if (!await dependencies.verifyLeaseOwner(owner)) {
        throw lostLease()
      }
    }
    if (!await dependencies.persistRecoveredCancellation({ ...owner, promptId })) throw lostLease()
    await dependencies.releaseLease(owner).catch(() => false)
    return { outcome: 'canceled' as const }
  }
  const history = await dependencies.getHistory(promptId)
  if (historyShowsExecutionFailure(history, promptId)) {
    await mustOwn(dependencies.persistRecoveredState({
      ...owner, promptId, status: 'failed', errorCode: COMFY_ERROR_CODE.EXECUTION_FAILED,
    }))
    return { outcome: 'failed' as const }
  }
  if (hasHistoryEntry(history, promptId) || Object.hasOwn(history, 'outputs')) {
    const outputs = extractComfyOutputs(history, context.version.outputs)
    await mustOwn(dependencies.persistRecoveredState({ ...owner, promptId, status: 'transferring', outputs }))
    return { outcome: 'transferring' as const, outputs }
  }
  queue ??= await dependencies.getQueue()
  const status = queueContainsPrompt(queue.running, promptId)
    ? 'running' as const
    : queueContainsPrompt(queue.pending, promptId)
      ? 'submitted' as const
      : null
  if (status === null && !await dependencies.isAbsenceConclusive?.({ ...owner, promptId })) {
    return { outcome: 'reconciling' as const }
  }
  await mustOwn(dependencies.persistRecoveredState({
    ...owner, promptId, status: status ?? 'failed',
    ...(status === null ? { errorCode: COMFY_ERROR_CODE.RECONCILIATION_REQUIRED } : {}),
  }))
  return { outcome: status ?? 'failed' }
}

export function findComfyPromptByClientId(
  queue: { running: unknown[]; pending: unknown[] },
  history: Record<string, unknown>,
  clientId: string,
) {
  for (const entry of [...queue.running, ...queue.pending].slice(0, 10_000)) {
    if (Array.isArray(entry) && typeof entry[1] === 'string'
      && isRecord(entry[3]) && entry[3].client_id === clientId) return entry[1]
  }
  for (const [promptId, rawEntry] of Object.entries(history).slice(0, 10_000)) {
    if (!isRecord(rawEntry)) continue
    const prompt = rawEntry.prompt
    const extra = Array.isArray(prompt) ? prompt[3] : rawEntry.extra_data
    if (isRecord(extra) && extra.client_id === clientId) return promptId
  }
  return null
}

export interface ComfyCancellationDependencies {
  loadOwnedRequest(requestId: string, userId: string): Promise<RequestRecord | null>
  cancelLocal(input: { requestId: string; userId: string; status: ComfyRequestStatus }): Promise<boolean>
  verifyLeaseOwner(input: OwnerInput): Promise<boolean>
  requestCancellation(input: OwnerInput & {
    observedStatus: ComfyRequestStatus; promptId?: string
  }): Promise<'canceled' | 'requested' | 'lost'>
  getQueue(): Promise<{ running: unknown[]; pending: unknown[] }>
  deleteQueuedPrompt(promptId: string): Promise<void>
  interruptPrompt(promptId: string): Promise<void>
  release(input: OwnerInput): Promise<boolean>
  markCanceledOwned(input: OwnerInput & { promptId?: string }): Promise<boolean>
}

export async function cancelComfyRequest(
  requestId: string,
  userId: string,
  dependencies: ComfyCancellationDependencies,
) {
  const request = await dependencies.loadOwnedRequest(requestId, userId)
  if (!request) throw new ApiError('NOT_FOUND')
  if (['completed', 'failed', 'canceled'].includes(request.status)) return { outcome: request.status }
  if (['waiting_capacity', 'blocked_no_compatible_instance'].includes(request.status)) {
    await mustOwn(dependencies.cancelLocal({ requestId, userId, status: request.status }))
    return { outcome: 'canceled' as const }
  }
  const owner = requireOwner(request)
  if (!await dependencies.verifyLeaseOwner(owner)) throw new ApiError('CONFLICT')
  const promptId = request.promptId ?? undefined
  const cancellation = await dependencies.requestCancellation({
    ...owner, observedStatus: request.status, ...(promptId ? { promptId } : {}),
  })
  if (cancellation === 'lost') throw new ApiError('CONFLICT')
  if (cancellation === 'canceled') {
    await dependencies.release(owner).catch(() => false)
    return { outcome: 'canceled' as const }
  }
  if (!promptId) return { outcome: 'canceling' as const }
  if (promptId) {
    const queue = await dependencies.getQueue()
    if (queueContainsPrompt(queue.pending, promptId)) {
      if (!await dependencies.verifyLeaseOwner(owner)) throw new ApiError('CONFLICT')
      await dependencies.deleteQueuedPrompt(promptId)
    } else if (queueContainsPrompt(queue.running, promptId)) {
      if (!await dependencies.verifyLeaseOwner(owner)) throw new ApiError('CONFLICT')
      await dependencies.interruptPrompt(promptId)
    }
  }
  await mustOwn(dependencies.markCanceledOwned({ ...owner, ...(promptId ? { promptId } : {}) }))
  await dependencies.release(owner).catch(() => false)
  return { outcome: 'canceled' as const }
}

function assertContext(context: ExecutionContext, owner: OwnerInput) {
  const request = context.request
  if (!context.connection || !context.connection.enabled
    || context.connection.id !== owner.connectionId
    || context.connection.userId !== request.userId
    || context.version.id !== request.workflowVersionId
    || context.version.workflowId !== request.workflowId) throw new ApiError('CONFLICT')
}

function requireOwner(request: RequestRecord) {
  if (!request.connectionId || !request.leaseId) throw new ApiError('CONFLICT')
  return {
    requestId: request.id, userId: request.userId,
    connectionId: request.connectionId, leaseId: request.leaseId,
  }
}

function queueContainsPrompt(entries: unknown[], promptId: string) {
  return entries.some((entry) => Array.isArray(entry) && entry[1] === promptId)
}

function hasHistoryEntry(history: Record<string, unknown>, promptId: string) {
  return Object.hasOwn(history, promptId)
    && typeof history[promptId] === 'object' && history[promptId] !== null
}

function historyShowsExecutionFailure(history: Record<string, unknown>, promptId: string) {
  const entry = history[promptId]
  if (!isRecord(entry)) return false
  const status = entry.status
  if (isRecord(status) && status.status_str === 'error') return true
  if (!isRecord(status) || !Array.isArray(status.messages)) return false
  return status.messages.some((message) => Array.isArray(message) && message[0] === 'execution_error')
}

async function mustOwn(value: boolean | Promise<boolean>) {
  if (!await value) throw lostLease()
}

function lostLease() {
  return new ApiError('CONFLICT')
}

function safeErrorCode(error: unknown, fallback: string) {
  return error instanceof ComfyError ? error.code : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
