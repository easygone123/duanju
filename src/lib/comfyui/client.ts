import { Agent, fetch as undiciFetch, FormData, type Dispatcher } from 'undici'
import WebSocket, { type ClientOptions } from 'ws'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { LookupFunction } from 'node:net'

import { buildComfyAuthorization } from './auth'
import { COMFY_ERROR_CODE, ComfyError, type ComfyErrorCode } from './errors'
import {
  buildComfyHttpError,
  readComfySuccessBody,
  sanitizeComfyNodeErrors,
  type ComfyHttpErrorContext,
} from './http-response'
import {
  authorizeComfyTarget,
  resolveComfyHost,
  type ComfyNetworkPolicyConfig,
  type ComfyResolver,
} from './network-policy'
import type {
  ComfyApiWorkflow,
  ComfyConnectionAuth,
  ComfyExecutionEvent,
  ComfyOutputRef,
  ComfyQueueSnapshot,
  ComfySystemStats,
  ComfyUploadedFile,
  ComfyUploadInput,
} from './types'
import { iterateComfyWebSocket } from './websocket-events'

type FetchInit = RequestInit & { dispatcher?: Dispatcher }
export type ComfyFetch = (input: string | URL, init?: FetchInit) => Promise<Response>
export type ComfyWebSocketFactory = (url: string, options: ClientOptions) => WebSocket

export interface ComfyClientOptions {
  baseUrl: string
  auth: ComfyConnectionAuth
  networkPolicy: ComfyNetworkPolicyConfig
  timeoutMs?: number
  outputTimeoutMs?: number
  maxJsonBytes?: number
  maxOutputBytes?: number
  maxErrorBytes?: number
  maxWorkflowBytes?: number
  maxInputBytes?: number
  wsIdleTimeoutMs?: number
  maxWsQueuedEvents?: number
  maxWsQueuedBytes?: number
  maxRedirects?: number
  resolveHost?: ComfyResolver
  fetchImpl?: ComfyFetch
  webSocketFactory?: ComfyWebSocketFactory
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_ERROR_BYTES = 8 * 1024
const DEFAULT_MAX_WORKFLOW_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_MAX_WS_QUEUED_EVENTS = 256
const DEFAULT_MAX_WS_QUEUED_BYTES = 1024 * 1024
const MAX_WS_QUEUED_EVENTS = 10_000
const MAX_WS_QUEUED_BYTES = 16 * 1024 * 1024

export class ComfyClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly outputTimeoutMs: number
  private readonly maxJsonBytes: number
  private readonly maxOutputBytes: number
  private readonly maxErrorBytes: number
  private readonly maxWorkflowBytes: number
  private readonly maxInputBytes: number
  private readonly wsIdleTimeoutMs: number
  private readonly maxWsQueuedEvents: number
  private readonly maxWsQueuedBytes: number
  private readonly maxRedirects: number
  private readonly resolveHost: ComfyResolver
  private readonly fetchImpl: ComfyFetch
  private readonly webSocketFactory: ComfyWebSocketFactory

  constructor(private readonly options: ComfyClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.outputTimeoutMs = options.outputTimeoutMs ?? this.timeoutMs
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxErrorBytes = options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES
    this.maxWorkflowBytes = options.maxWorkflowBytes ?? DEFAULT_MAX_WORKFLOW_BYTES
    this.maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
    this.wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? this.timeoutMs
    this.maxWsQueuedEvents = validateQueueLimit(
      options.maxWsQueuedEvents ?? DEFAULT_MAX_WS_QUEUED_EVENTS,
      MAX_WS_QUEUED_EVENTS,
    )
    this.maxWsQueuedBytes = validateQueueLimit(
      options.maxWsQueuedBytes ?? DEFAULT_MAX_WS_QUEUED_BYTES,
      MAX_WS_QUEUED_BYTES,
    )
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.resolveHost = options.resolveHost ?? resolveComfyHost
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as ComfyFetch)
    this.webSocketFactory = options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions))
  }

  getSystemStats(signal?: AbortSignal): Promise<ComfySystemStats> {
    return this.requestJson('system_stats', { method: 'GET', signal }, COMFY_ERROR_CODE.CONNECTION_OFFLINE)
  }

  async getQueue(): Promise<ComfyQueueSnapshot> {
    const value = await this.requestJson<Record<string, unknown>>(
      'queue', { method: 'GET' }, COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
    return {
      running: Array.isArray(value.queue_running) ? value.queue_running : [],
      pending: Array.isArray(value.queue_pending) ? value.queue_pending : [],
    }
  }

  getObjectInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson('object_info', { method: 'GET', signal }, COMFY_ERROR_CODE.CONNECTION_OFFLINE)
  }

  getModels(folder: string, signal?: AbortSignal): Promise<string[]> {
    return this.requestJson(
      `models/${encodeURIComponent(folder)}`,
      { method: 'GET', signal },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  async uploadImage(input: ComfyUploadInput): Promise<ComfyUploadedFile> {
    // The input limit applies to caller-provided source bytes; multipart framing is transport overhead.
    if (input.bytes.byteLength > this.maxInputBytes) {
      throw new ComfyError(COMFY_ERROR_CODE.INPUT_UPLOAD_FAILED, 'ComfyUI input exceeds size limit', {
        details: { actualBytes: input.bytes.byteLength, limitBytes: this.maxInputBytes },
      })
    }
    const form = new FormData()
    const bytes = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer
    form.append('image', new File([bytes], input.filename, { type: input.contentType }))
    if (input.subfolder !== undefined) form.append('subfolder', input.subfolder)
    if (input.overwrite !== undefined) form.append('overwrite', String(input.overwrite))
    return this.requestJson(
      'upload/image', { method: 'POST', body: form as unknown as BodyInit }, COMFY_ERROR_CODE.INPUT_UPLOAD_FAILED,
    )
  }

  async submitPrompt(graph: ComfyApiWorkflow, clientId: string): Promise<{ promptId: string }> {
    const body = JSON.stringify({ prompt: graph, client_id: clientId })
    const bodyBytes = Buffer.byteLength(body, 'utf8')
    if (bodyBytes > this.maxWorkflowBytes) {
      throw new ComfyError(COMFY_ERROR_CODE.PROMPT_REJECTED, 'ComfyUI workflow exceeds size limit', {
        details: { actualBytes: bodyBytes, limitBytes: this.maxWorkflowBytes },
      })
    }
    const result = await this.requestJson<Record<string, unknown>>(
      'prompt',
      { method: 'POST', body, headers: jsonHeaders() },
      COMFY_ERROR_CODE.PROMPT_REJECTED,
      { auth: this.options.auth, workflow: graph },
    )
    if (typeof result.prompt_id !== 'string' || result.prompt_id.length === 0) {
      throw new ComfyError(COMFY_ERROR_CODE.PROMPT_REJECTED, 'ComfyUI did not return a prompt id', {
        details: {
          nodeErrors: sanitizeComfyNodeErrors(result.node_errors, {
            auth: this.options.auth,
            workflow: graph,
          }),
        },
      })
    }
    return { promptId: result.prompt_id }
  }

  async *watchPrompt(
    promptId: string,
    clientId: string,
    signal: AbortSignal,
  ): AsyncIterable<ComfyExecutionEvent> {
    if (signal.aborted) return
    let websocket: WebSocket | undefined
    let websocketAgent: HttpAgent | HttpsAgent | undefined
    try {
      const endpoint = this.endpoint('ws')
      endpoint.searchParams.set('clientId', clientId)
      const authorized = await this.authorizeWithTimeout(endpoint, signal)
      const auth = buildComfyAuthorization(this.options.auth)
      const websocketUrl = new URL(authorized.url)
      websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      websocketAgent = websocketUrl.protocol === 'wss:'
        ? new HttpsAgent({ lookup: pinnedLookup(authorized.address, authorized.family) })
        : new HttpAgent({ lookup: pinnedLookup(authorized.address, authorized.family) })
      websocket = this.webSocketFactory(websocketUrl.href, {
        headers: auth ? { Authorization: auth } : undefined,
        handshakeTimeout: this.timeoutMs,
        maxPayload: this.maxJsonBytes,
        agent: websocketAgent,
      })
      for await (const event of iterateComfyWebSocket(
        websocket,
        promptId,
        signal,
        this.wsIdleTimeoutMs,
        this.options.auth,
        this.maxWsQueuedEvents,
        this.maxWsQueuedBytes,
      )) {
        yield event
      }
    } catch (error) {
      if (signal.aborted) return
      throw error
    } finally {
      if (websocket?.readyState === WebSocket.OPEN) websocket.close()
      else if (websocket?.readyState === WebSocket.CONNECTING) {
        websocket.once('error', ignoreWebSocketCleanupError)
        websocket.terminate()
      }
      websocketAgent?.destroy()
    }
  }

  getHistory(promptId: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      `history/${encodeURIComponent(promptId)}`,
      { method: 'GET' },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  getHistoryAll(): Promise<Record<string, unknown>> {
    return this.requestJson(
      'history',
      { method: 'GET' },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  downloadOutput(ref: ComfyOutputRef): Promise<Buffer> {
    const query = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder,
      type: ref.type,
    })
    return this.requestBytes(
      `view?${query.toString()}`,
      { method: 'GET' },
      COMFY_ERROR_CODE.OUTPUT_TRANSFER_FAILED,
      this.maxOutputBytes,
      undefined,
      this.outputTimeoutMs,
    )
  }

  async deleteQueuedPrompt(promptId: string): Promise<void> {
    await this.requestJson(
      'queue',
      { method: 'POST', body: JSON.stringify({ delete: [promptId] }), headers: jsonHeaders() },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  async deletePromptHistory(promptId: string): Promise<void> {
    await this.requestJson(
      'history',
      { method: 'POST', body: JSON.stringify({ delete: [promptId] }), headers: jsonHeaders() },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  private async requestJson<T>(
    endpoint: string,
    init: FetchInit,
    code: ComfyErrorCode,
    errorContext?: ComfyHttpErrorContext,
  ): Promise<T> {
    const bytes = await this.requestBytes(endpoint, init, code, this.maxJsonBytes, errorContext)
    try {
      return JSON.parse(bytes.toString('utf8')) as T
    } catch {
      throw new ComfyError(code, 'ComfyUI returned invalid JSON', { retryable: true })
    }
  }

  private async requestBytes(
    endpoint: string,
    init: FetchInit,
    code: ComfyErrorCode,
    limit: number,
    errorContext: ComfyHttpErrorContext = { auth: this.options.auth },
    timeoutMs: number = this.timeoutMs,
  ): Promise<Buffer> {
    let url = this.endpoint(endpoint)
    for (let redirects = 0; ; redirects += 1) {
      const controller = new AbortController()
      const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      let agent: Agent | undefined
      let failed = false
      try {
        const authorized = await abortable(
          authorizeComfyTarget(url, this.options.networkPolicy, this.resolveHost),
          signal,
        )
        agent = new Agent({
          connect: {
            lookup: pinnedLookup(authorized.address, authorized.family),
            servername: authorized.url.hostname,
          },
        })
        const headers = new Headers(init.headers)
        const auth = buildComfyAuthorization(this.options.auth)
        if (auth) headers.set('authorization', auth)
        const response = await this.fetchImpl(authorized.url, {
          ...init,
          headers,
          dispatcher: agent,
          redirect: 'manual',
          signal,
        })
        if (isRedirect(response.status)) {
          const cancellation = response.body?.cancel()
          if (cancellation) await abortable(cancellation, signal)
          const location = response.headers.get('location')
          if (!location || redirects >= this.maxRedirects) throw this.networkBlocked()
          const redirected = new URL(location, authorized.url)
          if (
            redirected.origin !== authorized.url.origin ||
            !redirected.pathname.startsWith(this.baseUrl.pathname)
          ) {
            throw this.networkBlocked()
          }
          url = redirected
          continue
        }
        if (!response.ok) {
          throw await buildComfyHttpError(response, this.maxErrorBytes, code, errorContext)
        }
        return await readComfySuccessBody(response, limit, code)
      } catch (error) {
        failed = true
        if (error instanceof ComfyError) throw error
        if (signal.aborted) {
          throw new ComfyError(COMFY_ERROR_CODE.EXECUTION_TIMEOUT, 'ComfyUI request timed out', {
            cause: error,
            retryable: true,
          })
        }
        throw new ComfyError(code, 'ComfyUI request failed', { cause: error, retryable: true })
      } finally {
        try {
          if (agent) {
            if (failed || controller.signal.aborted) {
              await agent.destroy()
            } else {
              await abortable(agent.close(), controller.signal)
            }
          }
        } catch {
          await agent?.destroy()
          if (controller.signal.aborted && !failed) {
            throw new ComfyError(
              COMFY_ERROR_CODE.EXECUTION_TIMEOUT,
              'ComfyUI transport cleanup timed out',
              { retryable: true },
            )
          }
        } finally {
          clearTimeout(timeout)
        }
      }
    }
  }

  private endpoint(relative: string): URL {
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) {
      throw this.networkBlocked()
    }
    return new URL(relative, this.baseUrl)
  }

  private async authorizeWithTimeout(url: URL, signal: AbortSignal) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await abortable(
        authorizeComfyTarget(url, this.options.networkPolicy, this.resolveHost),
        controller.signal,
      )
    } catch (error) {
      if (signal.aborted) throw error
      if (controller.signal.aborted) {
        throw new ComfyError(COMFY_ERROR_CODE.EXECUTION_TIMEOUT, 'ComfyUI authorization timed out', {
          cause: error,
          retryable: true,
        })
      }
      throw error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }

  private networkBlocked(): ComfyError {
    return new ComfyError(COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED, 'Redirect target is not permitted')
  }

}

function normalizeBaseUrl(rawUrl: string): URL {
  const base = new URL(rawUrl)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  base.search = ''
  base.hash = ''
  return base
}

function jsonHeaders(): HeadersInit {
  return { 'content-type': 'application/json' }
}

function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address, family }])
      return
    }
    callback(null, address, family)
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function ignoreWebSocketCleanupError(): void {
  // ws emits an expected asynchronous error when a CONNECTING socket is terminated.
}

function validateQueueLimit(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`WebSocket queue limit must be an integer between 1 and ${maximum}`)
  }
  return value
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
