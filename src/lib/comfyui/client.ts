import { Agent, fetch as undiciFetch, FormData, type Dispatcher } from 'undici'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { LookupFunction } from 'node:net'

import { buildComfyAuthorization, comfyAuthSecrets } from './auth'
import { COMFY_ERROR_CODE, ComfyError, type ComfyErrorCode } from './errors'
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

type FetchInit = RequestInit & { dispatcher?: Dispatcher }
export type ComfyFetch = (input: string | URL, init?: FetchInit) => Promise<Response>
export type ComfyWebSocketFactory = (url: string, options: ClientOptions) => WebSocket

export interface ComfyClientOptions {
  baseUrl: string
  auth: ComfyConnectionAuth
  networkPolicy: ComfyNetworkPolicyConfig
  timeoutMs?: number
  maxJsonBytes?: number
  maxOutputBytes?: number
  maxErrorBytes?: number
  maxRedirects?: number
  resolveHost?: ComfyResolver
  fetchImpl?: ComfyFetch
  webSocketFactory?: ComfyWebSocketFactory
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_ERROR_BYTES = 8 * 1024
const DEFAULT_MAX_REDIRECTS = 3

export class ComfyClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxJsonBytes: number
  private readonly maxOutputBytes: number
  private readonly maxErrorBytes: number
  private readonly maxRedirects: number
  private readonly resolveHost: ComfyResolver
  private readonly fetchImpl: ComfyFetch
  private readonly webSocketFactory: ComfyWebSocketFactory

  constructor(private readonly options: ComfyClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxJsonBytes = options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxErrorBytes = options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.resolveHost = options.resolveHost ?? resolveComfyHost
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as ComfyFetch)
    this.webSocketFactory = options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions))
  }

  getSystemStats(): Promise<ComfySystemStats> {
    return this.requestJson('system_stats', { method: 'GET' }, COMFY_ERROR_CODE.CONNECTION_OFFLINE)
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

  getObjectInfo(): Promise<Record<string, unknown>> {
    return this.requestJson('object_info', { method: 'GET' }, COMFY_ERROR_CODE.CONNECTION_OFFLINE)
  }

  getModels(folder: string): Promise<string[]> {
    return this.requestJson(
      `models/${encodeURIComponent(folder)}`,
      { method: 'GET' },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  uploadImage(input: ComfyUploadInput): Promise<ComfyUploadedFile> {
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
    const result = await this.requestJson<Record<string, unknown>>(
      'prompt',
      { method: 'POST', body: JSON.stringify({ prompt: graph, client_id: clientId }), headers: jsonHeaders() },
      COMFY_ERROR_CODE.PROMPT_REJECTED,
    )
    if (typeof result.prompt_id !== 'string' || result.prompt_id.length === 0) {
      throw new ComfyError(COMFY_ERROR_CODE.PROMPT_REJECTED, 'ComfyUI did not return a prompt id', {
        details: { nodeErrors: this.sanitize(result.node_errors) },
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
    const endpoint = this.endpoint('ws')
    endpoint.searchParams.set('clientId', clientId)
    let authorized
    try {
      authorized = await this.authorizeWithTimeout(endpoint, signal)
    } catch (error) {
      if (signal.aborted) return
      throw error
    }
    const auth = buildComfyAuthorization(this.options.auth)
    const websocketUrl = new URL(authorized.url)
    websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const websocketAgent = websocketUrl.protocol === 'wss:'
      ? new HttpsAgent({ lookup: pinnedLookup(authorized.address, authorized.family) })
      : new HttpAgent({ lookup: pinnedLookup(authorized.address, authorized.family) })
    const websocket = this.webSocketFactory(websocketUrl.href, {
      headers: auth ? { Authorization: auth } : undefined,
      handshakeTimeout: this.timeoutMs,
      maxPayload: this.maxJsonBytes,
      agent: websocketAgent,
    })
    const events = createEventQueue(signal, websocket)
    try {
      for await (const raw of events) {
        const event = mapExecutionEvent(raw, promptId, this.sanitize.bind(this))
        if (event) yield event
      }
    } finally {
      websocket.close()
      websocketAgent.destroy()
    }
  }

  getHistory(promptId: string): Promise<Record<string, unknown>> {
    return this.requestJson(
      `history/${encodeURIComponent(promptId)}`,
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
    )
  }

  async deleteQueuedPrompt(promptId: string): Promise<void> {
    await this.requestJson(
      'queue',
      { method: 'POST', body: JSON.stringify({ delete: [promptId] }), headers: jsonHeaders() },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  async interruptPrompt(promptId: string): Promise<void> {
    await this.requestJson(
      'interrupt',
      { method: 'POST', body: JSON.stringify({ prompt_id: promptId }), headers: jsonHeaders() },
      COMFY_ERROR_CODE.CONNECTION_OFFLINE,
    )
  }

  private async requestJson<T>(endpoint: string, init: FetchInit, code: ComfyErrorCode): Promise<T> {
    const bytes = await this.requestBytes(endpoint, init, code, this.maxJsonBytes)
    try {
      return JSON.parse(bytes.toString('utf8')) as T
    } catch (cause) {
      throw new ComfyError(code, 'ComfyUI returned invalid JSON', { cause, retryable: true })
    }
  }

  private async requestBytes(
    endpoint: string,
    init: FetchInit,
    code: ComfyErrorCode,
    limit: number,
  ): Promise<Buffer> {
    let url = this.endpoint(endpoint)
    for (let redirects = 0; ; redirects += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      let agent: Agent | undefined
      try {
        const authorized = await abortable(
          authorizeComfyTarget(url, this.options.networkPolicy, this.resolveHost),
          controller.signal,
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
          signal: controller.signal,
        })
        if (isRedirect(response.status)) {
          const location = response.headers.get('location')
          if (!location || redirects >= this.maxRedirects) throw this.networkBlocked()
          const redirected = new URL(location, authorized.url)
          if (redirected.origin !== authorized.url.origin) throw this.networkBlocked()
          await response.body?.cancel()
          url = redirected
          continue
        }
        if (!response.ok) {
          const body = await readBounded(response, this.maxErrorBytes)
          const responseText = body.toString('utf8')
          const responseJson = parseJsonObject(responseText)
          throw new ComfyError(
            code,
            `ComfyUI request failed (${response.status}): ${this.sanitizeText(responseText)}`,
            {
              details: code === COMFY_ERROR_CODE.PROMPT_REJECTED
                ? { nodeErrors: this.sanitize(responseJson?.node_errors) }
                : undefined,
            },
          )
        }
        return await readBounded(response, limit)
      } catch (error) {
        if (error instanceof ComfyError) throw error
        if (controller.signal.aborted) {
          throw new ComfyError(COMFY_ERROR_CODE.EXECUTION_TIMEOUT, 'ComfyUI request timed out', {
            cause: error,
            retryable: true,
          })
        }
        throw new ComfyError(code, 'ComfyUI request failed', { cause: error, retryable: true })
      } finally {
        clearTimeout(timeout)
        await agent?.close()
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

  private sanitize(value: unknown): unknown {
    if (typeof value === 'string') return this.sanitizeText(value)
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.sanitizeText(key), this.sanitize(item)]),
      )
    }
    return value
  }

  private sanitizeText(value: string): string {
    const secrets = comfyAuthSecrets(this.options.auth).filter(Boolean)
    return secrets.some((secret) => value.includes(secret)) ? '[REDACTED]' : value
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

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw bodyTooLarge()
  if (!response.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(rawChunk)
    size += chunk.length
    if (size > limit) throw bodyTooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function bodyTooLarge(): ComfyError {
  return new ComfyError(COMFY_ERROR_CODE.OUTPUT_TRANSFER_FAILED, 'ComfyUI response exceeded size limit')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function* createEventQueue(signal: AbortSignal, websocket: WebSocket): AsyncIterable<RawData> {
  const values: RawData[] = []
  let wake: (() => void) | undefined
  let ended = false
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const onMessage = (value: RawData, isBinary: boolean) => {
    if (!isBinary) values.push(value)
    notify()
  }
  const onEnd = () => {
    ended = true
    notify()
  }
  const onAbort = () => {
    ended = true
    websocket.close()
    notify()
  }
  websocket.on('message', onMessage)
  websocket.on('close', onEnd)
  websocket.on('error', onEnd)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (!ended || values.length > 0) {
      if (values.length > 0) {
        yield values.shift()!
        continue
      }
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    websocket.off('message', onMessage)
    websocket.off('close', onEnd)
    websocket.off('error', onEnd)
  }
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
      message: typeof data.exception_message === 'string' ? String(sanitize(data.exception_message)) : 'Execution failed',
      nodeErrors: sanitize(data.node_errors),
    }
  }
  return undefined
}
