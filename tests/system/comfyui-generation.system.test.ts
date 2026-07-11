import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cancelComfyRequest,
  dispatchComfyRequest,
  reconcileComfyRequest,
  type ComfyDispatcherDependencies,
} from '@/lib/comfyui/dispatcher'
import { deriveComfyHealth } from '@/lib/comfyui/health'
import { createComfyObservability } from '@/lib/comfyui/observability'
import { readComfyRuntimeConfig } from '@/lib/comfyui/runtime'
import { scheduleNextComfyRequest, type ComfySchedulerDependencies } from '@/lib/comfyui/scheduler'
import type { ComfyMediaType, ComfyStoredOutputRef } from '@/lib/comfyui/types'
import { FakeComfyUiServer } from '../helpers/fakes/comfyui-server'
import {
  readComfyContractCheckConfig,
  runComfyContractCheck,
} from '../../scripts/comfyui-contract-check'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MP4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function executionHarness(mediaType: ComfyMediaType, options: { status?: string; promptId?: string } = {}) {
  const stored = new Map<string, Buffer>()
  const completed: ComfyStoredOutputRef[][] = []
  const submitPrompt = vi.fn().mockResolvedValue({ promptId: `${mediaType}-prompt-1` })
  const uploadImage = vi.fn().mockResolvedValue({ name: 'input.png', subfolder: 'inputs', type: 'input' })
  const outputField = mediaType === 'image' ? 'images' : 'gifs'
  const outputFilename = mediaType === 'image' ? 'result.png' : 'result.mp4'
  const request = {
    id: `${mediaType}-request`, taskId: `${mediaType}-task`, invocationKey: `${mediaType}-invoke`,
    userId: 'user-a', projectId: 'project-a', mediaType,
    workflowId: `${mediaType}-workflow`, workflowVersionId: `${mediaType}-version`,
    variableSnapshot: {
      prompt: 'RAW_PROMPT_DO_NOT_LOG',
      input: { storageKey: 'users/user-a/input.png', filename: 'input.png', mimeType: 'image/png' },
    },
    status: (options.status ?? 'leased') as 'leased', connectionId: 'connection-a', leaseId: 'lease-a',
    outputRefs: undefined as unknown[] | undefined,
    ...(options.promptId ? { promptId: options.promptId } : {}),
  }
  const context = {
    request,
    connection: { id: 'connection-a', userId: 'user-a', enabled: true },
    version: {
      id: `${mediaType}-version`, workflowId: `${mediaType}-workflow`,
      graph: {
        '1': { class_type: 'LoadImage', inputs: { image: '' } },
        '2': { class_type: mediaType === 'image' ? 'SaveImage' : 'SaveAnimatedWEBP', inputs: { source: ['1', 0], text: '' } },
      },
      variableDefinitions: [
        { name: 'prompt', type: 'string' as const, required: true },
        { name: 'input', type: 'image_ref' as const, required: true },
      ],
      bindings: [
        { nodeId: '1', inputPath: 'image', variable: 'input', valueType: 'image_ref' as const, transform: 'filename' as const },
        { nodeId: '2', inputPath: 'text', variable: 'prompt', valueType: 'string' as const },
      ],
      outputs: [{ name: 'primary', nodeId: '2', fieldPath: outputField, mediaType, primary: true }],
    },
  }
  const metrics = { increment: vi.fn(), observe: vi.fn(), gauge: vi.fn() }
  const logs: unknown[] = []
  const observation = createComfyObservability({
    logger: {
      info: (message, fields) => logs.push({ message, fields }),
      warn: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
    metrics,
    context: { requestId: request.id, taskId: request.taskId },
  })
  const dependencies: ComfyDispatcherDependencies = {
    loadContext: vi.fn().mockResolvedValue(context), recheckClaim: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(true),
    transition: vi.fn().mockResolvedValue(true), preSubmitGate: vi.fn().mockResolvedValue('ready'),
    blockIncompatible: vi.fn().mockResolvedValue(true),
    claimSubmissionFence: vi.fn().mockResolvedValue({ outcome: 'claimed', attemptId: 'attempt-a', clientId: 'client-a' }),
    recordAcceptedPrompt: vi.fn().mockResolvedValue({ outcome: 'request_recorded' }),
    cancelIfRequested: vi.fn().mockResolvedValue(false), cancelBeforeTransfer: vi.fn().mockResolvedValue(false),
    persistProgress: vi.fn().mockResolvedValue(true), persistOutputRefs: vi.fn().mockResolvedValue(true),
    persistCompletedOutputs: vi.fn(async ({ outputs }) => { completed.push(outputs); return true }),
    persistStoredOutputReceipt: vi.fn().mockResolvedValue(true), returnToWaiting: vi.fn().mockResolvedValue(true),
    markReconciling: vi.fn().mockResolvedValue(true), markFailed: vi.fn().mockResolvedValue(true),
    client: {
      uploadImage, submitPrompt,
      watchPrompt: async function* () { yield { type: 'executing' as const, promptId: `${mediaType}-prompt-1`, nodeId: null } },
      getHistory: vi.fn().mockResolvedValue({ outputs: { '2': { [outputField]: [{ filename: outputFilename, subfolder: '', type: 'output' }] } } }),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      downloadOutput: vi.fn().mockResolvedValue(mediaType === 'image' ? PNG : MP4),
      deleteQueuedPrompt: vi.fn(),
    },
    resolveOwnedMedia: vi.fn().mockResolvedValue(true), readOwnedObject: vi.fn().mockResolvedValue(PNG),
    uploadObject: vi.fn(async (bytes, key) => { stored.set(key, bytes); return key }),
    objectExists: vi.fn().mockResolvedValue(false), resolveStoredUrl: (key) => `/api/files/${key}`,
    randomId: vi.fn().mockReturnValueOnce('client-a').mockReturnValue('attempt-a'),
    signal: new AbortController().signal, leaseTtlMs: 30_000, observation,
  }
  return { context, dependencies, submitPrompt, uploadImage, stored, completed, metrics, logs, observation }
}

describe('system - ComfyUI generation acceptance', () => {
  it.each(['image', 'video'] as const)('submits an arbitrary %s workflow and persists its primary output', async (mediaType) => {
    const harness = executionHarness(mediaType)
    const result = await dispatchComfyRequest(harness.context.request.id, harness.dependencies)

    expect(result).toMatchObject({ outcome: 'completed', primary: { mediaType, primary: true } })
    expect(harness.uploadImage).toHaveBeenCalledOnce()
    expect(harness.submitPrompt).toHaveBeenCalledOnce()
    expect(harness.submitPrompt.mock.calls[0][0]['1'].inputs.image).toBe('input.png')
    expect(harness.submitPrompt.mock.calls[0][0]['2'].inputs.text).toBe('RAW_PROMPT_DO_NOT_LOG')
    expect([...harness.stored.keys()][0]).toMatch(new RegExp(`^comfyui/user-a/project-a/${mediaType}-request/`))
    expect(harness.completed[0][0].url).toMatch(/^\/api\/files\/comfyui\//)
  })

  it('keeps busy work in waoowaoo, assigns after idle, excludes other users, and enforces one lease', async () => {
    let state: 'online_busy_external' | 'online_idle' = 'online_busy_external'
    let leaseHeld = false
    const assign = vi.fn().mockResolvedValue('assigned')
    const dependencies: ComfySchedulerDependencies = {
      listSchedulableRequests: vi.fn().mockResolvedValue([{
        id: 'request-a', userId: 'user-a', workflowVersionId: 'version-a',
        status: 'waiting_capacity', queuedAt: new Date(0), priority: 0,
      }]),
      listOwnedEnabledConnections: vi.fn().mockResolvedValue([
        { id: 'connection-b', userId: 'user-b', enabled: true, lastAssignedAt: null },
        { id: 'connection-a', userId: 'user-a', enabled: true, lastAssignedAt: null },
      ]),
      readCachedHealth: vi.fn(async () => ({ state })), checkCachedCompatibility: vi.fn().mockResolvedValue(true),
      acquireLease: vi.fn(async () => { if (leaseHeld) return false; leaseHeld = true; return true }),
      releaseLease: vi.fn(async () => { leaseHeld = false; return true }),
      makeWaitingIfBlocked: vi.fn().mockResolvedValue(true), assignIfEligible: assign,
      markBlockedIfEligible: vi.fn().mockResolvedValue(true),
    }
    const external = deriveComfyHealth({
      checkedAt: new Date(0), systemStats: { system: {}, devices: [] },
      queue: { running: [['manual-prompt']], pending: [] }, ownedNonterminalCount: 0,
    })
    expect(external.state).toBe('online_busy_external')
    expect(await scheduleNextComfyRequest('user-a', dependencies)).toMatchObject({ outcome: 'waiting_capacity' })
    expect(assign).not.toHaveBeenCalled()

    state = 'online_idle'
    expect(await scheduleNextComfyRequest('user-a', dependencies, { newLeaseId: () => 'lease-a' }))
      .toMatchObject({ outcome: 'leased', connectionId: 'connection-a' })
    expect(assign).toHaveBeenCalledOnce()
    expect(await scheduleNextComfyRequest('user-a', dependencies)).toMatchObject({ outcome: 'lost_race' })
    expect(assign).toHaveBeenCalledOnce()
  })

  it('cancels an owned queued prompt without touching unrelated or other-user work', async () => {
    let pending: unknown[] = [[0, 'owned-prompt'], [1, 'manual-prompt']]
    const deleted = vi.fn(async (promptId: string) => { pending = pending.filter((entry) => (entry as unknown[])[1] !== promptId) })
    const result = await cancelComfyRequest('request-a', 'user-a', {
      loadOwnedRequest: vi.fn(async (requestId, userId) => requestId === 'request-a' && userId === 'user-a'
        ? { id: requestId, userId, status: 'submitted' as const, connectionId: 'connection-a', leaseId: 'lease-a', promptId: 'owned-prompt' }
        : null),
      cancelLocal: vi.fn(), verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      requestCancellation: vi.fn().mockResolvedValue('requested'),
      getQueue: vi.fn(async () => ({ running: [], pending })), getHistory: vi.fn().mockResolvedValue({}),
      isAbsenceConclusive: vi.fn().mockResolvedValue(true), deleteQueuedPrompt: deleted,
      release: vi.fn().mockResolvedValue(true), markCanceledOwned: vi.fn().mockResolvedValue(true),
    })
    expect(result).toEqual({ outcome: 'canceled' })
    expect(deleted).toHaveBeenCalledWith('owned-prompt')
    expect(pending).toEqual([[1, 'manual-prompt']])
    await expect(cancelComfyRequest('request-a', 'user-b', {
      loadOwnedRequest: vi.fn().mockResolvedValue(null), cancelLocal: vi.fn(), verifyLeaseOwner: vi.fn(),
      requestCancellation: vi.fn(), getQueue: vi.fn(), getHistory: vi.fn(), deleteQueuedPrompt: vi.fn(),
      release: vi.fn(), markCanceledOwned: vi.fn(),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('recovers an accepted prompt after restart and transfers without duplicate submission', async () => {
    const harness = executionHarness('image', { status: 'submitted', promptId: 'image-prompt-1' })
    const first = await dispatchComfyRequest('image-request', harness.dependencies)
    expect(first).toEqual({ outcome: 'reconciling', promptId: 'image-prompt-1' })
    expect(harness.submitPrompt).not.toHaveBeenCalled()

    const persistedOutputs: unknown[][] = []
    const recovered = await reconcileComfyRequest('image-request', {
      loadContext: vi.fn().mockResolvedValue(harness.context), verifyLeaseOwner: vi.fn().mockResolvedValue(true),
      getQueue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
      getHistory: harness.dependencies.client.getHistory, recordAttemptAbsence: vi.fn(),
      deleteQueuedPrompt: vi.fn(), persistRecoveredCancellation: vi.fn(), persistRecoveredDiagnostics: vi.fn(),
      releaseLease: vi.fn().mockResolvedValue(true),
      persistRecoveredState: vi.fn(async ({ outputs }) => { persistedOutputs.push(outputs ?? []); return true }),
    })
    expect(recovered).toMatchObject({ outcome: 'transferring' })

    const transfer = executionHarness('image', { status: 'transferring', promptId: 'image-prompt-1' })
    transfer.context.request.outputRefs = persistedOutputs[0] as never
    const completed = await dispatchComfyRequest('image-request', transfer.dependencies)
    expect(completed).toMatchObject({ outcome: 'completed' })
    expect(transfer.submitPrompt).not.toHaveBeenCalled()
  })

  it('emits bounded metrics and redacts credentials and raw prompts from captured logs', async () => {
    const harness = executionHarness('image')
    harness.observation.info('contract-check', {
      authorization: 'Bearer SECRET', prompt: 'RAW_PROMPT_DO_NOT_LOG',
      endpoint: 'https://comfy.example/prefix?token=SECRET', status: 'completed',
    })
    await dispatchComfyRequest('image-request', harness.dependencies)
    const captured = JSON.stringify(harness.logs)
    expect(captured).not.toContain('SECRET')
    expect(captured).not.toContain('RAW_PROMPT_DO_NOT_LOG')
    expect(captured).toContain('[REDACTED]')
    expect(harness.metrics.increment).toHaveBeenCalledWith('comfy.workflow_success', 1, { outcome: 'completed' })
    expect(harness.metrics.observe).toHaveBeenCalledWith('comfy.execution_duration_ms', expect.any(Number), { mediaType: 'image' })
  })

  it('defaults to allowlist and requires an explicit trusted deployment choice', () => {
    expect(readComfyRuntimeConfig({ COMFYUI_ENABLED: 'false' }).networkPolicy.mode).toBe('allowlist')
    expect(readComfyRuntimeConfig({ COMFYUI_ENABLED: 'true', COMFYUI_NETWORK_MODE: 'trusted' }).networkPolicy.mode).toBe('trusted')
    expect(() => readComfyRuntimeConfig({ COMFYUI_ENABLED: 'true' })).toThrow()
  })

  it('runs the opt-in real contract path against a fake server without logging workflow data', async () => {
    expect(() => readComfyContractCheckConfig({})).toThrow(/COMFYUI_CONTRACT_URL/)
    const directory = await mkdtemp(join(tmpdir(), 'comfy-contract-'))
    temporaryPaths.push(directory)
    const workflowFile = join(directory, 'workflow.json')
    await writeFile(workflowFile, JSON.stringify({
      graph: { '1': { class_type: 'SaveImage', inputs: { text: '${prompt}' } } },
      variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
      variables: { prompt: 'CONTRACT_RAW_PROMPT' },
      outputs: [{ name: 'primary', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true }],
    }))
    const server = new FakeComfyUiServer()
    server.override('/proxy/comfy/object_info', (_request, response) => response.end(JSON.stringify({ SaveImage: { input: {} } })))
    server.override('/proxy/comfy/queue', (_request, response) => response.end(JSON.stringify({ queue_running: [], queue_pending: [] })))
    server.override('/proxy/comfy/history/prompt-1', (_request, response) => response.end(JSON.stringify({
      'prompt-1': { outputs: { '1': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } },
    })))
    server.override('/proxy/comfy/view', (_request, response) => response.end(PNG))
    await server.start()
    try {
      const output: string[] = []
      const result = await runComfyContractCheck(readComfyContractCheckConfig({
        COMFYUI_CONTRACT_URL: server.baseUrl,
        COMFYUI_CONTRACT_WORKFLOW_FILE: workflowFile,
        COMFYUI_NETWORK_MODE: 'allowlist', COMFYUI_ALLOWED_CIDRS: '127.0.0.1/32',
      }), { write: (line) => output.push(line) })
      expect(result.primary).toMatchObject({ mediaType: 'image', byteSize: PNG.byteLength })
      const submitted = server.requests.find((request) => request.method === 'POST' && request.path.endsWith('/prompt'))
      expect(submitted?.body.toString('utf8')).toContain('CONTRACT_RAW_PROMPT')
      expect(submitted?.body.toString('utf8')).not.toContain('${prompt}')
      expect(JSON.stringify(output)).not.toContain('SaveImage')
      expect(JSON.stringify(output)).not.toContain('result.png')
      expect(JSON.stringify(output)).not.toContain('CONTRACT_RAW_PROMPT')
    } finally {
      await server.close()
    }
  })
})
