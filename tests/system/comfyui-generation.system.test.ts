import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveModelSelection } from '@/lib/api-config'
import { buildDefaultTaskBillingInfo } from '@/lib/billing/task-policy'
import { checkComfyCompatibility } from '@/lib/comfyui/compatibility'
import {
  cancelComfyRequest,
  dispatchComfyRequest,
} from '@/lib/comfyui/dispatcher'
import { COMFY_ERROR_CODE } from '@/lib/comfyui/errors'
import { monitorComfyHealth } from '@/lib/comfyui/health'
import { authorizeComfyTarget } from '@/lib/comfyui/network-policy'
import { pollComfyGenerationRequest } from '@/lib/comfyui/provider'
import { readComfyRuntimeConfig } from '@/lib/comfyui/runtime'
import {
  assignComfyRequestWithStore,
  scheduleNextComfyRequest,
  type ComfySchedulableConnection,
  type ComfySchedulableRequest,
  type ComfySchedulerDependencies,
} from '@/lib/comfyui/scheduler'
import { deriveComfyRequirements } from '@/lib/comfyui/workflow-requirements'
import { getProjectModelConfig } from '@/lib/config-service'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { prisma } from '@/lib/prisma'
import { TASK_TYPE } from '@/lib/task/types'
import {
  readComfyContractCheckConfig,
  runComfyContractCheck,
} from '../../scripts/comfyui-contract-check'
import {
  AcceptanceComfyServer,
  CapturedComfyTelemetry,
  InMemoryComfyExecution,
  InMemoryComfyStorage,
  MP4,
  PNG,
  createAggregate,
  workflowContract,
} from './helpers/comfyui-acceptance'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

async function startExecution(mediaType: 'image' | 'video', transferFailures = 0) {
  const server = new AcceptanceComfyServer()
  server.installDynamicHistoryRoutes()
  await server.start()
  const aggregate = createAggregate(mediaType)
  const storage = new InMemoryComfyStorage()
  storage.transferFailures = transferFailures
  const key = `users/user-a/input.${mediaType === 'image' ? 'png' : 'mp4'}`
  storage.seed(key, {
    bytes: mediaType === 'image' ? PNG : MP4,
    userId: 'user-a', projectId: 'project-a', mediaType,
  })
  const telemetry = new CapturedComfyTelemetry()
  const execution = new InMemoryComfyExecution(server.client(), storage, aggregate, telemetry)
  return { server, aggregate, storage, telemetry, execution }
}

type PrismaMethodPatch = { target: Record<string, unknown>; key: string; value: unknown }

async function withPrismaMethods<T>(patches: PrismaMethodPatch[], operation: () => Promise<T>): Promise<T> {
  const originals = patches.map(({ target, key }) => ({ target, key, value: target[key] }))
  for (const patch of patches) patch.target[patch.key] = patch.value
  try {
    return await operation()
  } finally {
    for (const original of originals) original.target[original.key] = original.value
  }
}

describe('system - ComfyUI executable acceptance evidence', () => {
  it('REQ-COMFYUI-AC-01 reports idle, owned busy, external busy, offline, auth, and incompatible states', async () => {
    const server = new AcceptanceComfyServer()
    await server.start()
    let owned = false
    const contract = workflowContract('image')
    const client = server.client()
    const monitor = () => monitorComfyHealth({
      connectionId: 'connection-a', checkedAt: new Date(), ttlMs: 1_000,
      workflowHash: 'workflow-hash', graph: contract.graph,
      requirements: deriveComfyRequirements(contract.graph),
    }, {
      authorize: async () => { await authorizeComfyTarget(server.baseUrl, {
        mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'],
      }) },
      getSystemStats: () => client.getSystemStats(), getQueue: () => client.getQueue(),
      hasLease: async () => owned,
      checkCompatibility: (input) => checkComfyCompatibility({ ...input, client }),
      cacheEval: async () => 1,
    })
    try {
      await expect(monitor()).resolves.toMatchObject({ health: { state: 'online_idle' } })
      owned = true
      await expect(monitor()).resolves.toMatchObject({ health: { state: 'online_busy_owned' } })
      owned = false
      server.running = [[0, 'manual-prompt']]
      await expect(monitor()).resolves.toMatchObject({ health: { state: 'online_busy_external' } })
      server.running = []
      server.requiredAuthorization = 'Bearer required-token'
      await expect(monitor()).resolves.toMatchObject({ health: { state: 'auth_failed' } })
      server.requiredAuthorization = undefined
      server.objectInfo = {}
      await expect(monitor()).resolves.toMatchObject({ health: { state: 'workflow_incompatible' } })
    } finally {
      await server.close()
    }
    await expect(monitor()).resolves.toMatchObject({ health: { state: 'offline' } })
  })

  it('REQ-COMFYUI-AC-02 imports arbitrary API Format placeholders and mappings into a real server execution', async () => {
    const run = await startExecution('image')
    try {
      const result = await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
      expect(result).toMatchObject({ outcome: 'completed', primary: { mediaType: 'image', primary: true } })
      const upload = run.server.server.requests.find((entry) => entry.path.endsWith('/upload/image'))
      const prompt = run.server.server.requests.find((entry) => entry.path.endsWith('/prompt'))
      expect(upload?.body.byteLength).toBeGreaterThan(PNG.byteLength)
      expect(prompt?.body.toString('utf8')).toContain('RAW_PROMPT_DO_NOT_LOG')
      expect(prompt?.body.toString('utf8')).toContain('uploaded-1')
      expect(prompt?.body.toString('utf8')).not.toContain('${prompt}')
      expect(run.server.promptCount).toBe(1)
    } finally {
      await run.server.close()
    }
  })

  it('REQ-COMFYUI-AC-03 resolves task override, project Comfy default, specialized model, user default, and fixed version', async () => {
    let binding: Record<string, unknown> | null = {
      imageWorkflowId: 'project-workflow', imageWorkflowVersionId: 'project-version-fixed',
      videoWorkflowId: null, videoWorkflowVersionId: null,
    }
    let project: Record<string, unknown> = {
      analysisModel: null, characterModel: 'cloud::character', locationModel: 'cloud::location',
      storyboardModel: 'cloud::specialized', editModel: 'cloud::edit', videoModel: 'cloud::video',
      audioModel: null, capabilityOverrides: null,
    }
    const user = {
      analysisModel: null, characterModel: 'user::character', locationModel: 'user::location',
      storyboardModel: 'user::default', editModel: 'user::edit', videoModel: 'user::video',
      audioModel: null, capabilityDefaults: null,
    }
    const delegates = prisma as unknown as Record<string, Record<string, unknown>>
    await withPrismaMethods([
      { target: delegates.novelPromotionProject, key: 'findUnique', value: async () => project },
      { target: delegates.userPreference, key: 'findUnique', value: async () => user },
      { target: delegates.projectComfyBinding, key: 'findUnique', value: async () => binding },
      { target: delegates.comfyWorkflow, key: 'findFirst', value: async (input: { where: { id: string } }) => ({
        currentVersionId: `${input.where.id}-version-fixed`,
      }) },
    ], async () => {
      const task = await getProjectModelConfig('project-a', 'user-a', { imageModel: 'comfyui::task-workflow' })
      expect(task.storyboardModel).toBe('comfyui::task-workflow')
      expect(task.comfyImageWorkflowVersionId).toBe('task-workflow-version-fixed')
      const projectDefault = await getProjectModelConfig('project-a', 'user-a')
      expect(projectDefault.storyboardModel).toBe('comfyui::project-workflow')
      expect(projectDefault.comfyImageWorkflowVersionId).toBe('project-version-fixed')
      binding = null
      expect((await getProjectModelConfig('project-a', 'user-a')).storyboardModel).toBe('cloud::specialized')
      project = { ...project, storyboardModel: null }
      expect((await getProjectModelConfig('project-a', 'user-a')).storyboardModel).toBe('user::default')
    })
  })

  it('REQ-COMFYUI-AC-04 keeps connections, workflows, requests, and stored outputs private across users', async () => {
    const run = await startExecution('image')
    try {
      const completed = await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
      expect(completed.outcome).toBe('completed')
      const output = run.aggregate.request.outputRefs?.find((item) => 'storageKey' in item)
      expect(output && 'storageKey' in output).toBe(true)
      if (!output || !('storageKey' in output)) throw new Error('missing stored output')
      await expect(run.storage.readOwnedObject({
        userId: 'user-b', projectId: 'project-a', storageKey: output.storageKey, maxBytes: 1024,
      })).rejects.toThrow('owned object unavailable')

      const delegates = prisma as unknown as Record<string, Record<string, unknown>>
      await withPrismaMethods([
        { target: delegates.comfyGenerationRequest, key: 'findFirst', value: async (input: { where: { userId: string } }) =>
          input.where.userId === 'user-a'
            ? { status: 'completed', outputRefs: run.aggregate.request.outputRefs, errorMessage: null }
            : null },
        { target: delegates.comfyWorkflow, key: 'findFirst', value: async (input: { where: { userId: string } }) =>
          input.where.userId === 'user-a'
            ? { id: 'image-workflow', currentVersionId: 'version-fixed', currentVersion: { id: 'version-fixed', publishedAt: new Date() } }
            : null },
      ], async () => {
        await expect(pollComfyGenerationRequest({ requestId: 'image-request', userId: 'user-b', mediaType: 'image' }))
          .rejects.toMatchObject({ code: 'NOT_FOUND' })
        await expect(resolveModelSelection('user-b', 'comfyui::image-workflow', 'image'))
          .rejects.toThrow('MODEL_NOT_FOUND')
      })
      let leaseAttempts = 0
      const isolationSchedule = await scheduleNextComfyRequest('user-a', {
        listSchedulableRequests: async () => [{
          id: 'private-request', userId: 'user-a', workflowVersionId: 'version-fixed',
          status: 'waiting_capacity', queuedAt: new Date(0), priority: 0,
        }],
        listOwnedEnabledConnections: async () => [{
          id: 'user-b-connection', userId: 'user-b', enabled: true, lastAssignedAt: null,
        }],
        readCachedHealth: async () => ({ state: 'online_idle' }),
        checkCachedCompatibility: async () => true,
        acquireLease: async () => { leaseAttempts += 1; return true },
        releaseLease: async () => true, makeWaitingIfBlocked: async () => true,
        assignIfEligible: async () => 'assigned', markBlockedIfEligible: async () => true,
      })
      expect(isolationSchedule).toMatchObject({ outcome: 'blocked_no_compatible_instance' })
      expect(leaseAttempts).toBe(0)
    } finally {
      await run.server.close()
    }
  })

  it('REQ-COMFYUI-AC-05 preserves priority/FIFO, idle/LRU assignment, capacity wait, and concurrency one', async () => {
    const requests: ComfySchedulableRequest[] = [
      { id: 'fifo-first', userId: 'user-a', workflowVersionId: 'version-a', status: 'waiting_capacity', queuedAt: new Date(0), priority: 1 },
      { id: 'fifo-second', userId: 'user-a', workflowVersionId: 'version-a', status: 'waiting_capacity', queuedAt: new Date(1), priority: 1 },
    ]
    const connections: ComfySchedulableConnection[] = [
      { id: 'recent', userId: 'user-a', enabled: true, lastAssignedAt: new Date(10) },
      { id: 'least-recent', userId: 'user-a', enabled: true, lastAssignedAt: new Date(5) },
    ]
    const leases = new Set<string>()
    const active = new Map<string, string>()
    let state: 'online_idle' | 'online_busy_external' = 'online_busy_external'
    const assignmentStore: Parameters<typeof assignComfyRequestWithStore>[1] = {
      transaction: async (operation) => operation({
        countActiveRequests: async (input) => {
          const where = input.where as { connectionId: string; id: { not: string } }
          return active.get(where.connectionId) && active.get(where.connectionId) !== where.id.not ? 1 : 0
        },
        updateConnection: async (input) => {
          const where = input.where as { id: string; userId: string }
          const connection = connections.find((item) => item.id === where.id && item.userId === where.userId)
          if (!connection) return { count: 0 }
          connection.lastAssignedAt = (input.data as { lastAssignedAt: Date }).lastAssignedAt
          return { count: 1 }
        },
        updateRequest: async (input) => {
          const where = input.where as { id: string; userId: string }
          const request = requests.find((item) => item.id === where.id && item.userId === where.userId)
          if (!request || active.has((input.data as { connectionId: string }).connectionId)) return { count: 0 }
          const data = input.data as { connectionId: string }
          active.set(data.connectionId, request.id)
          requests.splice(requests.indexOf(request), 1)
          return { count: 1 }
        },
      }),
    }
    const dependencies: ComfySchedulerDependencies = {
      listSchedulableRequests: async () => [...requests],
      listOwnedEnabledConnections: async () => [...connections],
      readCachedHealth: async () => ({ state }), checkCachedCompatibility: async () => true,
      acquireLease: async ({ connectionId }) => {
        if (leases.has(connectionId)) return false
        leases.add(connectionId); return true
      },
      releaseLease: async ({ connectionId }) => leases.delete(connectionId),
      makeWaitingIfBlocked: async () => true, markBlockedIfEligible: async () => true,
      assignIfEligible: (input) => assignComfyRequestWithStore(input, assignmentStore),
    }
    await expect(scheduleNextComfyRequest('user-a', dependencies)).resolves.toMatchObject({ outcome: 'waiting_capacity' })
    state = 'online_idle'
    await expect(scheduleNextComfyRequest('user-a', dependencies, { newLeaseId: () => 'lease-1' }))
      .resolves.toMatchObject({ outcome: 'leased', requestId: 'fifo-first', connectionId: 'least-recent' })
    const directBusy = await assignComfyRequestWithStore({
      requestId: 'fifo-second', userId: 'user-a', connectionId: 'least-recent', leaseId: 'lease-2',
      leaseExpiresAt: new Date(100), assignedAt: new Date(20),
    }, assignmentStore)
    expect(directBusy).toBe('connection_busy')
  })

  it('REQ-COMFYUI-AC-06 transfers real image and video inputs and primary outputs through production client transport', async () => {
    for (const mediaType of ['image', 'video'] as const) {
      const run = await startExecution(mediaType)
      try {
        const result = await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
        expect(result).toMatchObject({ outcome: 'completed', primary: { mediaType } })
        expect(run.server.uploadCount).toBe(1)
        const stored = run.aggregate.request.outputRefs?.find((item) => 'storageKey' in item)
        expect(stored && 'byteSize' in stored ? stored.byteSize : 0).toBe(mediaType === 'image' ? PNG.byteLength : MP4.byteLength)
      } finally {
        await run.server.close()
      }
    }
  })

  it('REQ-COMFYUI-AC-07 retries transfer after restart without resubmitting an accepted prompt', async () => {
    const run = await startExecution('image', 1)
    try {
      await expect(dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies()))
        .resolves.toMatchObject({ outcome: 'reconciling', promptId: 'prompt-1' })
      expect(run.server.promptCount).toBe(1)
      const restarted = new InMemoryComfyExecution(
        run.server.client(), run.storage, run.aggregate, run.telemetry,
      )
      await expect(dispatchComfyRequest(run.aggregate.request.id, restarted.dependencies()))
        .resolves.toMatchObject({ outcome: 'completed' })
      expect(run.server.promptCount).toBe(1)
      expect(run.aggregate.request.status).toBe('completed')
    } finally {
      await run.server.close()
    }
  })

  it('REQ-COMFYUI-AC-08 cancels an owned queued prompt, preserves manual work, and safely leaves running work canceling', async () => {
    const server = new AcceptanceComfyServer()
    server.pending = [[0, 'owned-prompt'], [1, 'manual-prompt']]
    server.installHistoryRoute('owned-prompt')
    await server.start()
    const client = server.client()
    const request = {
      id: 'request-a', userId: 'user-a', status: 'submitted' as const,
      connectionId: 'connection-a', leaseId: 'lease-a', promptId: 'owned-prompt',
    }
    const cancellationDependencies = {
      loadOwnedRequest: async (_requestId: string, userId: string) => userId === 'user-a' ? request : null,
      cancelLocal: async () => true, verifyLeaseOwner: async () => true,
      requestCancellation: async () => 'requested' as const,
      getQueue: () => client.getQueue(), getHistory: (promptId: string) => client.getHistory(promptId),
      isAbsenceConclusive: async () => true, deleteQueuedPrompt: (promptId: string) => client.deleteQueuedPrompt(promptId),
      release: async () => true, markCanceledOwned: async () => true,
    }
    try {
      await expect(cancelComfyRequest('request-a', 'user-a', cancellationDependencies))
        .resolves.toEqual({ outcome: 'canceled' })
      expect(server.pending).toEqual([[1, 'manual-prompt']])
      server.pending = []
      server.running = [[0, 'owned-prompt']]
      await expect(cancelComfyRequest('request-a', 'user-a', cancellationDependencies))
        .resolves.toEqual({ outcome: 'canceling' })
      expect(server.interruptCount).toBe(0)
      expect(server.running).toEqual([[0, 'owned-prompt']])
    } finally {
      await server.close()
    }
  })

  it('REQ-COMFYUI-AC-09 skips billing while emitting progress, diagnostics, metrics, and redacted logs', async () => {
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, {
      imageModel: 'comfyui::workflow-a', count: 2,
    })).toEqual({ billable: false, source: 'task', status: 'skipped' })
    expect(buildDefaultTaskBillingInfo(TASK_TYPE.VIDEO_PANEL, {
      videoModel: 'comfyui::workflow-v', count: 1,
    })).toEqual({ billable: false, source: 'task', status: 'skipped' })
    const run = await startExecution('image')
    try {
      run.execution.dependencies().observation?.info('diagnostic', {
        authorization: 'Bearer SECRET', prompt: 'RAW_PROMPT_DO_NOT_LOG', status: 'completed',
      })
      await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
      expect(run.execution.progressEvents).toBeGreaterThan(0)
      expect(run.telemetry.metrics).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'comfy.execution_duration_ms', labels: { mediaType: 'image' } }),
        expect.objectContaining({ name: 'comfy.workflow_success', labels: { outcome: 'completed' } }),
      ]))
      const captured = JSON.stringify(run.telemetry.logs)
      expect(captured).not.toContain('SECRET')
      expect(captured).not.toContain('RAW_PROMPT_DO_NOT_LOG')
      expect(captured).toContain('[REDACTED]')
    } finally {
      await run.server.close()
    }
  })

  it('REQ-COMFYUI-AC-10 enforces allowlist/trusted security, auth, and SSRF metadata blocking', async () => {
    const server = new AcceptanceComfyServer()
    server.requiredAuthorization = 'Bearer required-token'
    await server.start()
    try {
      await expect(server.client({ type: 'bearer', token: 'required-token' }).getSystemStats())
        .resolves.toMatchObject({ system: { comfyui_version: 'fake-1' } })
      await expect(server.client({ type: 'none' }).getSystemStats())
        .rejects.toMatchObject({ code: COMFY_ERROR_CODE.AUTH_FAILED })
      expect(readComfyRuntimeConfig({ COMFYUI_ENABLED: 'false' }).networkPolicy.mode).toBe('allowlist')
      expect(readComfyRuntimeConfig({ COMFYUI_ENABLED: 'true', COMFYUI_NETWORK_MODE: 'trusted' }).networkPolicy.mode).toBe('trusted')
      await expect(authorizeComfyTarget('http://127.0.0.1:8188', {
        mode: 'allowlist', allowedHosts: [], allowedCidrs: [],
      })).rejects.toMatchObject({ code: COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED })
      await expect(authorizeComfyTarget('http://169.254.169.254/latest/meta-data', {
        mode: 'trusted', allowedHosts: [], allowedCidrs: [],
      })).rejects.toMatchObject({ code: COMFY_ERROR_CODE.NETWORK_TARGET_BLOCKED })
    } finally {
      await server.close()
    }
  })

  it('REQ-COMFYUI-AC-11 preserves strict ComfyUI and cloud provider coexistence without provider guessing', async () => {
    const delegates = prisma as unknown as Record<string, Record<string, unknown>>
    await withPrismaMethods([
      { target: delegates.comfyWorkflow, key: 'findFirst', value: async () => ({
        id: 'workflow-a', currentVersionId: 'version-fixed',
        currentVersion: { id: 'version-fixed', publishedAt: new Date() },
      }) },
      { target: delegates.userPreference, key: 'findUnique', value: async () => ({
        customModels: JSON.stringify([{ provider: 'cloud-a', modelId: 'image-a', modelKey: 'cloud-a::image-a', type: 'image', name: 'Cloud A' }]),
        customProviders: JSON.stringify([{ id: 'cloud-a', name: 'Cloud A', apiKey: 'encrypted' }]),
      }) },
    ], async () => {
      await expect(resolveModelSelection('user-a', 'comfyui::workflow-a', 'image'))
        .resolves.toMatchObject({ provider: 'comfyui', modelId: 'workflow-a' })
      await expect(resolveModelSelection('user-a', 'cloud-a::image-a', 'image'))
        .resolves.toMatchObject({ provider: 'cloud-a', modelId: 'image-a' })
      expect(parseModelKeyStrict('legacy-image-a')).toBeNull()
      await expect(resolveModelSelection('user-a', 'legacy-image-a', 'image')).rejects.toThrow('MODEL_KEY_INVALID')
    })
  })

  it('keeps the opt-in real contract checker on production network/auth/client paths', async () => {
    expect(() => readComfyContractCheckConfig({})).toThrow(/COMFYUI_CONTRACT_URL/)
    const directory = await mkdtemp(join(tmpdir(), 'comfy-contract-'))
    temporaryPaths.push(directory)
    const workflowFile = join(directory, 'workflow.json')
    await writeFile(workflowFile, JSON.stringify({
      graph: {
        '1': { class_type: 'SaveImage', inputs: { text: '${prompt}' } },
        '3': { class_type: 'SaveImage', inputs: { source: ['1', 0] } },
      },
      variableDefinitions: [{ name: 'prompt', type: 'string', required: true }],
      variables: { prompt: 'CONTRACT_RAW_PROMPT' },
      outputs: [{ name: 'primary', nodeId: '3', fieldPath: 'images', mediaType: 'image', primary: true }],
    }))
    const server = new AcceptanceComfyServer()
    server.objectInfo = { SaveImage: { input: {} } }
    server.installDynamicHistoryRoutes()
    await server.start()
    try {
      const output: string[] = []
      const result = await runComfyContractCheck(readComfyContractCheckConfig({
        COMFYUI_CONTRACT_URL: server.baseUrl,
        COMFYUI_CONTRACT_WORKFLOW_FILE: workflowFile,
        COMFYUI_ALLOWED_CIDRS: '127.0.0.1/32',
      }), { write: (line) => output.push(line) })
      expect(result.primary).toMatchObject({ mediaType: 'image', byteSize: PNG.byteLength })
      expect(JSON.stringify(output)).not.toContain('CONTRACT_RAW_PROMPT')
    } finally {
      await server.close()
    }
  })
})
