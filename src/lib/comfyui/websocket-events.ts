import type { ClientRequest, IncomingMessage } from 'node:http'

import WebSocket, { type RawData } from 'ws'

import { COMFY_ERROR_CODE, ComfyError } from './errors'
import { sanitizeComfyExecutionNodeId } from './http-response'
import type { ComfyConnectionAuth, ComfyExecutionEvent } from './types'

interface QueuedExecutionEvent {
  event: ComfyExecutionEvent
  bytes: number
  replacementKey?: string
}

export async function* iterateComfyWebSocket(
  websocket: WebSocket,
  promptId: string,
  signal: AbortSignal,
  idleTimeoutMs: number,
  auth: ComfyConnectionAuth,
  maxQueuedEvents: number,
  maxQueuedBytes: number,
): AsyncIterable<ComfyExecutionEvent> {
  const values: QueuedExecutionEvent[] = []
  let queuedBytes = 0
  let wake: (() => void) | undefined
  let ended = false
  let failure: ComfyError | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const notify = () => {
    wake?.()
    wake = undefined
  }
  const fail = (error: ComfyError) => {
    if (!failure && !signal.aborted) failure = error
    ended = true
    notify()
  }
  const clearQueue = () => {
    values.length = 0
    queuedBytes = 0
  }
  const overflow = (reason: 'queue_count_limit' | 'queue_bytes_limit') => {
    clearQueue()
    failure = new ComfyError(
      COMFY_ERROR_CODE.EXECUTION_FAILED,
      'ComfyUI WebSocket event queue exceeded its limit',
      { details: { reason }, retryable: true },
    )
    ended = true
    cleanup()
    if (websocket.readyState === WebSocket.OPEN) websocket.terminate()
    notify()
  }
  const enqueue = (event: ComfyExecutionEvent): boolean => {
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    const replacementKey = replaceableEventKey(event)
    const replaceIndex = replacementKey
      ? values.findIndex((queued) => queued.replacementKey === replacementKey)
      : -1
    if (replaceIndex >= 0) {
      queuedBytes -= values[replaceIndex].bytes
      values[replaceIndex] = { event, bytes, replacementKey }
    } else {
      values.push({ event, bytes, replacementKey })
    }
    queuedBytes += bytes
    if (values.length > maxQueuedEvents) {
      overflow('queue_count_limit')
      return false
    }
    if (queuedBytes > maxQueuedBytes) {
      overflow('queue_bytes_limit')
      return false
    }
    notify()
    return true
  }
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      fail(new ComfyError(
        COMFY_ERROR_CODE.EXECUTION_TIMEOUT,
        'ComfyUI WebSocket became idle',
        { retryable: true },
      ))
      websocket.terminate()
    }, idleTimeoutMs)
  }
  const onOpen = () => resetIdleTimer()
  const onMessage = (raw: RawData, isBinary: boolean) => {
    if (isBinary || signal.aborted) return
    const event = mapExecutionEvent(raw, promptId, auth)
    if (!event) return
    if (!enqueue(event)) return
    resetIdleTimer()
  }
  const onError = (error: Error) => {
    fail(new ComfyError(
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
      'ComfyUI WebSocket connection failed',
      { cause: error, retryable: true },
    ))
  }
  const onUnexpectedResponse = (_request: ClientRequest, response: IncomingMessage) => {
    const status = response.statusCode
    response.destroy()
    fail(new ComfyError(
      status === 401 || status === 403
        ? COMFY_ERROR_CODE.AUTH_FAILED
        : COMFY_ERROR_CODE.CONNECTION_OFFLINE,
      status === 401 || status === 403
        ? 'ComfyUI WebSocket authentication failed'
        : 'ComfyUI WebSocket handshake failed',
      { details: { httpStatus: status }, retryable: status !== 401 && status !== 403 },
    ))
  }
  const onClose = () => {
    if (!signal.aborted && !failure) {
      failure = new ComfyError(
        COMFY_ERROR_CODE.CONNECTION_OFFLINE,
        'ComfyUI WebSocket closed unexpectedly',
        { retryable: true },
      )
    }
    ended = true
    notify()
  }
  const onAbort = () => {
    ended = true
    clearQueue()
    cleanup()
    if (websocket.readyState === WebSocket.OPEN) websocket.close()
    else if (websocket.readyState === WebSocket.CONNECTING) {
      websocket.once('error', ignoreCleanupError)
      websocket.terminate()
    }
    notify()
  }

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    signal.removeEventListener('abort', onAbort)
    websocket.off('open', onOpen)
    websocket.off('message', onMessage)
    websocket.off('error', onError)
    websocket.off('unexpected-response', onUnexpectedResponse)
    websocket.off('close', onClose)
  }

  websocket.on('open', onOpen)
  websocket.on('message', onMessage)
  websocket.on('error', onError)
  websocket.on('unexpected-response', onUnexpectedResponse)
  websocket.on('close', onClose)
  signal.addEventListener('abort', onAbort, { once: true })
  if (websocket.readyState === WebSocket.OPEN) resetIdleTimer()

  try {
    while (!ended || values.length > 0) {
      if (values.length > 0) {
        const next = values.shift()!
        queuedBytes -= next.bytes
        yield next.event
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
    if (failure) throw failure
  } finally {
    cleanup()
  }
}

function ignoreCleanupError(): void {
  // ws emits an expected asynchronous error when cancellation interrupts its handshake.
}

function mapExecutionEvent(
  raw: RawData,
  promptId: string,
  auth: ComfyConnectionAuth,
): ComfyExecutionEvent | undefined {
  let message: { type?: string; data?: Record<string, unknown> }
  try {
    message = JSON.parse(raw.toString()) as typeof message
  } catch {
    return undefined
  }
  const data = message.data ?? {}
  if (message.type !== 'status' && data.prompt_id !== promptId) return undefined
  const publicPromptId = safePromptId(promptId)
  if (message.type === 'status') {
    const status = data.status as { exec_info?: { queue_remaining?: unknown } } | undefined
    const queueRemaining = status?.exec_info?.queue_remaining
    return {
      type: 'status',
      ...(isBoundedCount(queueRemaining) ? { queueRemaining } : {}),
    }
  }
  if (message.type === 'execution_start') return { type: 'execution_start', promptId: publicPromptId }
  if (message.type === 'executing') {
    return {
      type: 'executing',
      promptId: publicPromptId,
      nodeId: sanitizeComfyExecutionNodeId(data.node, auth) ?? null,
    }
  }
  if (message.type === 'progress' && isBoundedProgress(data.value, data.max)) {
    const nodeId = sanitizeComfyExecutionNodeId(data.node, auth)
    return {
      type: 'progress', promptId: publicPromptId,
      ...(nodeId ? { nodeId } : {}),
      value: Number(data.value), max: Number(data.max),
    }
  }
  if (message.type === 'executed') {
    return {
      type: 'executed',
      promptId: publicPromptId,
      nodeId: sanitizeComfyExecutionNodeId(data.node, auth) ?? null,
    }
  }
  if (message.type === 'execution_error') {
    const nodeId = sanitizeComfyExecutionNodeId(data.node_id, auth)
    return {
      type: 'execution_error', promptId: publicPromptId,
      ...(nodeId ? { nodeId } : {}),
      message: 'Execution failed',
    }
  }
  return undefined
}

function safePromptId(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : '[REDACTED]'
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000
}

function isBoundedProgress(value: unknown, max: unknown): value is number {
  return (
    isBoundedCount(value) &&
    isBoundedCount(max) &&
    Number(max) > 0 &&
    Number(value) <= Number(max)
  )
}

function replaceableEventKey(event: ComfyExecutionEvent): string | undefined {
  if (event.type === 'status') return 'status'
  if (event.type === 'progress') return `progress:${event.nodeId ?? ''}`
  return undefined
}
