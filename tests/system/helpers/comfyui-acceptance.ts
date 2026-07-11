import type { ServerResponse } from 'node:http'

import { checkComfyCompatibility } from '@/lib/comfyui/compatibility'
import { ComfyClient } from '@/lib/comfyui/client'
import type { ComfyDispatcherDependencies } from '@/lib/comfyui/dispatcher'
import { createComfyObservability } from '@/lib/comfyui/observability'
import { deriveComfyRequirements } from '@/lib/comfyui/workflow-requirements'
import { validateWorkflowContract } from '@/lib/comfyui/workflow-schema'
import type {
  ComfyApiWorkflow,
  ComfyInputBinding,
  ComfyMediaType,
  ComfyOutputBinding,
  ComfyOutputRef,
  ComfyRequestStatus,
  ComfyStoredOutputRef,
  ComfyVariableDefinition,
  ComfyVariableValue,
} from '@/lib/comfyui/types'
import { FakeComfyUiServer } from '../../helpers/fakes/comfyui-server'

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MP4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])

function sendJson(response: ServerResponse, value: unknown, status = 200) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

export class AcceptanceComfyServer {
  readonly server = new FakeComfyUiServer()
  running: unknown[] = []
  pending: unknown[] = []
  promptCount = 0
  uploadCount = 0
  interruptCount = 0
  historyDeleteCount = 0
  submitQueueMode: 'none' | 'pending' | 'running' = 'none'
  historyStatus = 200
  downloadStatus = 200
  websocketMode: 'complete' | 'disconnect' = 'complete'
  historyVisible = true
  requiredAuthorization?: string
  systemStatus = 200
  objectInfo: Record<string, unknown> = {
    LoadImage: { input: {} }, LoadVideo: { input: {} }, PromptText: { input: {} }, SaveImage: { input: {} },
    VHS_VideoCombine: { input: {} },
  }
  private readonly histories = new Map<string, Record<string, unknown>>()
  private readonly outputBytes = new Map<string, Buffer>()

  constructor() {
    this.server.override('/proxy/comfy/system_stats', (request, response) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      sendJson(response, { system: { comfyui_version: 'fake-1' }, devices: [] }, this.systemStatus)
    })
    this.server.override('/proxy/comfy/object_info', (request, response) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      sendJson(response, this.objectInfo)
    })
    this.server.override('/proxy/comfy/queue', (request, response, body) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      if (request.method === 'POST') {
        const parsed = JSON.parse(body.toString('utf8')) as { delete?: string[] }
        if (parsed.delete) {
          this.pending = this.pending.filter((entry) => !parsed.delete!.includes(promptIdOf(entry) ?? ''))
        }
        return sendJson(response, {})
      }
      sendJson(response, { queue_running: this.running, queue_pending: this.pending })
    })
    this.server.override('/proxy/comfy/upload/image', (request, response) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      this.uploadCount += 1
      sendJson(response, { name: `uploaded-${this.uploadCount}`, subfolder: 'inputs', type: 'input' })
    })
    this.server.override('/proxy/comfy/prompt', (request, response, body) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      const submitted = JSON.parse(body.toString('utf8')) as { prompt: ComfyApiWorkflow; client_id: string }
      this.promptCount += 1
      const promptId = `prompt-${this.promptCount}`
      if (this.submitQueueMode === 'pending') this.pending.push([this.promptCount, promptId])
      if (this.submitQueueMode === 'running') this.running.push([this.promptCount, promptId])
      const mediaType = Object.values(submitted.prompt).some((node) => node.class_type === 'VHS_VideoCombine')
        ? 'video' : 'image'
      const filename = mediaType === 'video' ? `${promptId}.mp4` : `${promptId}.png`
      const field = mediaType === 'video' ? 'gifs' : 'images'
      this.histories.set(promptId, {
        [promptId]: { outputs: { '3': { [field]: [{ filename, subfolder: '', type: 'output' }] } } },
      })
      this.outputBytes.set(filename, mediaType === 'video' ? MP4 : PNG)
      sendJson(response, { prompt_id: promptId, number: this.promptCount, node_errors: {} })
      void this.server.waitForSocket().then(() => {
        if (this.websocketMode === 'disconnect') {
          void this.server.closeSockets()
          return
        }
        this.server.send({ type: 'progress', data: { prompt_id: promptId, node: '3', value: 1, max: 1 } })
        this.server.send({ type: 'executing', data: { prompt_id: promptId, node: null } })
      })
    })
    this.server.override('/proxy/comfy/interrupt', (_request, response) => {
      this.interruptCount += 1
      this.running = []
      sendJson(response, {})
    })
    this.server.override('/proxy/comfy/history', (_request, response, body) => {
      const parsed = JSON.parse(body.toString('utf8')) as { delete?: string[] }
      for (const promptId of parsed.delete ?? []) this.histories.delete(promptId)
      this.historyDeleteCount += 1
      sendJson(response, {})
    })
    this.server.override('/proxy/comfy/view', (request, response) => {
      if (this.downloadStatus !== 200) return sendJson(response, {}, this.downloadStatus)
      const filename = new URL(request.url ?? '/', 'http://localhost').searchParams.get('filename') ?? ''
      response.setHeader('content-type', 'application/octet-stream')
      response.end(this.outputBytes.get(filename) ?? Buffer.alloc(0))
    })
  }

  start() { return this.server.start() }
  close() { return this.server.close() }
  get baseUrl() { return this.server.baseUrl }

  setHistory(promptId: string, history: Record<string, unknown>) {
    this.histories.set(promptId, history)
  }

  installHistoryRoute(promptId: string) {
    this.server.override(`/proxy/comfy/history/${promptId}`, (request, response) => {
      if (!this.authorized(request.headers.authorization)) return sendJson(response, {}, 401)
      sendJson(
        response,
        this.historyVisible ? this.histories.get(promptId) ?? {} : {},
        this.historyStatus,
      )
    })
  }

  installDynamicHistoryRoutes(maxPrompts = 10) {
    for (let index = 1; index <= maxPrompts; index += 1) this.installHistoryRoute(`prompt-${index}`)
  }

  client(auth: { type: 'none' } | { type: 'bearer'; token: string } = { type: 'bearer', token: 'test-token' }) {
    return new ComfyClient({
      baseUrl: this.baseUrl, auth,
      networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      timeoutMs: 2_000, wsIdleTimeoutMs: 2_000,
    })
  }

  private authorized(value: string | undefined) {
    return !this.requiredAuthorization || value === this.requiredAuthorization
  }
}

function promptIdOf(entry: unknown) {
  return Array.isArray(entry) && typeof entry[1] === 'string' ? entry[1] : null
}

interface StoredMedia {
  bytes: Buffer
  userId: string
  projectId: string
  mediaType: ComfyMediaType
}

export class InMemoryComfyStorage {
  readonly objects = new Map<string, StoredMedia>()
  transferFailures = 0

  seed(key: string, value: StoredMedia) { this.objects.set(key, value) }

  async resolveOwnedMedia(input: { userId: string; projectId: string; storageKey: string; mediaType: ComfyMediaType }) {
    const value = this.objects.get(input.storageKey)
    return value?.userId === input.userId && value.projectId === input.projectId
      && value.mediaType === input.mediaType
  }

  async readOwnedObject(input: { userId: string; projectId: string; storageKey: string; maxBytes: number }) {
    const value = this.objects.get(input.storageKey)
    if (!value || value.userId !== input.userId || value.projectId !== input.projectId
      || value.bytes.byteLength > input.maxBytes) throw new Error('owned object unavailable')
    return Buffer.from(value.bytes)
  }

  async uploadObject(bytes: Buffer, key: string, _maxRetries: number, contentType: string) {
    if (this.transferFailures > 0) {
      this.transferFailures -= 1
      throw new Error('storage unavailable')
    }
    const [, userId, projectId] = key.split('/')
    this.objects.set(key, {
      bytes: Buffer.from(bytes), userId, projectId,
      mediaType: contentType.startsWith('video/') ? 'video' : 'image',
    })
    return key
  }

  async objectExists(key: string) { return this.objects.has(key) }
  resolveStoredUrl(key: string) { return `/api/files/${key}` }
}

export class CapturedComfyTelemetry {
  readonly logs: unknown[] = []
  readonly metrics: Array<{ kind: string; name: string; value: number; labels: Record<string, string> }> = []
  readonly logger = {
    info: (message: string, fields: Record<string, unknown>) => { this.logs.push({ message, fields }) },
    warn: (message: string, fields: Record<string, unknown>) => { this.logs.push({ message, fields }) },
    error: (message: string, fields: Record<string, unknown>) => { this.logs.push({ message, fields }) },
  }
  readonly metricSink = {
    increment: (name: string, value: number, labels: Record<string, string>) => this.metrics.push({ kind: 'increment', name, value, labels }),
    observe: (name: string, value: number, labels: Record<string, string>) => this.metrics.push({ kind: 'observe', name, value, labels }),
    gauge: (name: string, value: number, labels: Record<string, string>) => this.metrics.push({ kind: 'gauge', name, value, labels }),
  }
}

export interface ExecutionAggregate {
  request: {
    id: string; taskId: string; invocationKey: string; userId: string; projectId: string
    mediaType: ComfyMediaType; workflowId: string; workflowVersionId: string
    variableSnapshot: Record<string, ComfyVariableValue>; status: ComfyRequestStatus
    connectionId: string; leaseId: string; promptId?: string; clientId?: string
    cancelRequestedAt?: Date; outputRefs?: Array<ComfyOutputRef | ComfyStoredOutputRef>
  }
  attempt?: { id: string; clientId: string; promptId?: string }
  released: boolean
}

export function workflowContract(mediaType: ComfyMediaType) {
  const inputType = mediaType === 'image' ? 'image_ref' as const : 'video_ref' as const
  const loader = mediaType === 'image' ? 'LoadImage' : 'LoadVideo'
  const saver = mediaType === 'image' ? 'SaveImage' : 'VHS_VideoCombine'
  const outputField = mediaType === 'image' ? 'images' : 'gifs'
  const graph = {
    '1': { class_type: loader, inputs: { media: '' } },
    '2': { class_type: 'PromptText', inputs: { text: '${prompt}' } },
    '3': { class_type: saver, inputs: { source: ['1', 0], text: '' } },
  }
  const variableDefinitions: ComfyVariableDefinition[] = [
    { name: 'prompt', type: 'string', required: true },
    { name: 'input', type: inputType, required: true },
  ]
  const bindings: ComfyInputBinding[] = [
    { nodeId: '1', inputPath: 'media', variable: 'input', valueType: inputType, transform: 'filename' },
    { nodeId: '3', inputPath: 'text', variable: 'prompt', valueType: 'string' },
  ]
  const outputs: ComfyOutputBinding[] = [
    { name: 'primary', nodeId: '3', fieldPath: outputField, mediaType, primary: true },
  ]
  const issues = validateWorkflowContract({ graph, variableDefinitions, bindings, outputs })
  if (issues.length > 0) throw new Error(`invalid acceptance workflow: ${issues[0].code}`)
  return { graph, variableDefinitions, bindings, outputs }
}

export class InMemoryComfyExecution {
  readonly telemetry: CapturedComfyTelemetry
  readonly contract: ReturnType<typeof workflowContract>
  private id = 0
  progressEvents = 0

  constructor(
    readonly client: ComfyClient,
    readonly storage: InMemoryComfyStorage,
    readonly aggregate: ExecutionAggregate,
    telemetry = new CapturedComfyTelemetry(),
  ) {
    this.telemetry = telemetry
    this.contract = workflowContract(aggregate.request.mediaType)
  }

  dependencies(): ComfyDispatcherDependencies {
    const request = this.aggregate.request
    const owner = () => !this.aggregate.released
    return {
      loadContext: async () => ({
        request: { ...request, submissionAttempt: this.aggregate.attempt ?? null },
        connection: { id: request.connectionId, userId: request.userId, enabled: true },
        version: {
          id: request.workflowVersionId, workflowId: request.workflowId,
          ...this.contract, requirements: deriveComfyRequirements(this.contract.graph),
          contentHash: `${request.workflowVersionId}-hash`,
        },
      }),
      recheckClaim: async () => owner(), heartbeat: async () => owner(),
      release: async () => { this.aggregate.released = true; return true },
      transition: async ({ from, to }) => {
        if (request.status !== from) return false
        request.status = to
        return true
      },
      preSubmitGate: async () => {
        const queue = await this.client.getQueue()
        if (queue.running.length + queue.pending.length > 0) return 'external_busy'
        const compatibility = await checkComfyCompatibility({
          connectionId: request.connectionId, workflowHash: `${request.workflowVersionId}-hash`,
          graph: this.contract.graph, requirements: deriveComfyRequirements(this.contract.graph),
          client: this.client,
        })
        return compatibility.compatible ? 'ready' : 'incompatible'
      },
      blockIncompatible: async () => { request.status = 'blocked_no_compatible_instance'; return true },
      claimSubmissionFence: async ({ attemptId, clientId }) => {
        if (request.cancelRequestedAt) return { outcome: 'canceled' }
        request.status = 'submitting'; request.clientId = clientId
        this.aggregate.attempt = { id: attemptId, clientId }
        return { outcome: 'claimed', attemptId, clientId }
      },
      recordAcceptedPrompt: async ({ attemptId, clientId, promptId }) => {
        request.status = 'submitted'; request.promptId = promptId
        this.aggregate.attempt = { id: attemptId, clientId, promptId }
        return { outcome: 'request_recorded' }
      },
      cancelIfRequested: async () => 'continue',
      cancelBeforeTransfer: async () => {
        if (!request.cancelRequestedAt) return false
        request.status = 'canceled'; return true
      },
      persistProgress: async () => { this.progressEvents += 1; request.status = 'running'; return true },
      persistOutputRefs: async ({ outputs }) => { request.status = 'transferring'; request.outputRefs = outputs; return true },
      persistStoredOutputReceipt: async ({ output }) => {
        request.outputRefs = (request.outputRefs ?? []).map((item) => item.name === output.name ? output : item)
        return true
      },
      persistCompletedOutputs: async ({ outputs }) => { request.status = 'completed'; request.outputRefs = outputs; return true },
      returnToWaiting: async () => { request.status = 'waiting_capacity'; return true },
      markReconciling: async ({ promptId }) => { request.status = 'reconciling'; request.promptId = promptId; return true },
      markFailed: async () => { request.status = 'failed'; return true },
      client: this.client,
      resolveOwnedMedia: (input) => this.storage.resolveOwnedMedia(input),
      readOwnedObject: (input) => this.storage.readOwnedObject(input),
      uploadObject: (bytes, key, retries, contentType) => this.storage.uploadObject(bytes, key, retries, contentType),
      objectExists: (key) => this.storage.objectExists(key),
      resolveStoredUrl: (key) => this.storage.resolveStoredUrl(key),
      randomId: () => `runtime-${++this.id}`,
      signal: new AbortController().signal, leaseTtlMs: 30_000,
      observation: createComfyObservability({
        logger: this.telemetry.logger, metrics: this.telemetry.metricSink,
        context: { requestId: request.id, taskId: request.taskId, workflowId: request.workflowId },
      }),
    }
  }
}

export function createAggregate(mediaType: ComfyMediaType, userId = 'user-a'): ExecutionAggregate {
  const extension = mediaType === 'image' ? 'png' : 'mp4'
  return {
    request: {
      id: `${mediaType}-request`, taskId: `${mediaType}-task`, invocationKey: `${mediaType}-invoke`,
      userId, projectId: 'project-a', mediaType, workflowId: `${mediaType}-workflow`,
      workflowVersionId: `${mediaType}-version-fixed`,
      variableSnapshot: {
        prompt: 'RAW_PROMPT_DO_NOT_LOG',
        input: { storageKey: `users/${userId}/input.${extension}`, filename: `input.${extension}` },
      },
      status: 'leased', connectionId: 'connection-a', leaseId: 'lease-a',
    },
    released: false,
  }
}
