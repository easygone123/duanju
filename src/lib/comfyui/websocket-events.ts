import type { ClientRequest, IncomingMessage } from 'node:http'

import WebSocket, { type RawData } from 'ws'

import { COMFY_ERROR_CODE, ComfyError } from './errors'
import type { ComfyExecutionEvent } from './types'

export async function* iterateComfyWebSocket(
  websocket: WebSocket,
  promptId: string,
  signal: AbortSignal,
  idleTimeoutMs: number,
  sanitize: (value: unknown) => unknown,
): AsyncIterable<ComfyExecutionEvent> {
  const values: ComfyExecutionEvent[] = []
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
    if (isBinary) return
    const event = mapExecutionEvent(raw, promptId, sanitize)
    if (!event) return
    values.push(event)
    resetIdleTimer()
    notify()
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
    if (websocket.readyState === WebSocket.OPEN) websocket.close()
    else if (websocket.readyState === WebSocket.CONNECTING) {
      websocket.once('error', ignoreCleanupError)
      websocket.terminate()
    }
    notify()
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
        yield values.shift()!
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
    if (failure) throw failure
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    signal.removeEventListener('abort', onAbort)
    websocket.off('open', onOpen)
    websocket.off('message', onMessage)
    websocket.off('error', onError)
    websocket.off('unexpected-response', onUnexpectedResponse)
    websocket.off('close', onClose)
  }
}

function ignoreCleanupError(): void {
  // ws emits an expected asynchronous error when cancellation interrupts its handshake.
}

function mapExecutionEvent(
  raw: RawData,
  promptId: string,
  sanitize: (value: unknown) => unknown,
): ComfyExecutionEvent | undefined {
  let message: { type?: string; data?: Record<string, unknown> }
  try {
    message = JSON.parse(raw.toString()) as typeof message
  } catch {
    return undefined
  }
  const data = message.data ?? {}
  if (message.type !== 'status' && data.prompt_id !== promptId) return undefined
  if (message.type === 'status') {
    const status = data.status as { exec_info?: { queue_remaining?: unknown } } | undefined
    const queueRemaining = status?.exec_info?.queue_remaining
    return { type: 'status', queueRemaining: typeof queueRemaining === 'number' ? queueRemaining : undefined }
  }
  if (message.type === 'execution_start') return { type: 'execution_start', promptId }
  if (message.type === 'executing') {
    return { type: 'executing', promptId, nodeId: typeof data.node === 'string' ? data.node : null }
  }
  if (message.type === 'progress' && typeof data.value === 'number' && typeof data.max === 'number') {
    return {
      type: 'progress', promptId,
      nodeId: typeof data.node === 'string' ? data.node : undefined,
      value: data.value, max: data.max,
    }
  }
  if (message.type === 'executed' && typeof data.node === 'string') {
    return { type: 'executed', promptId, nodeId: data.node, output: data.output }
  }
  if (message.type === 'execution_error') {
    return {
      type: 'execution_error', promptId,
      nodeId: typeof data.node_id === 'string' ? data.node_id : undefined,
      message: typeof data.exception_message === 'string'
        ? String(sanitize(data.exception_message))
        : 'Execution failed',
      nodeErrors: sanitize(data.node_errors),
    }
  }
  return undefined
}
