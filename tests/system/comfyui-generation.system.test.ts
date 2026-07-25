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
  reconcileComfyRequest,
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

async function writeContractWorkflow() {
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
    outputs: [{
      name: 'primary', nodeId: '3', fieldPath: 'images', mediaType: 'image', primary: true,
    }],
  }))
  return workflowFile
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
      await expect(authorizeComfyTarget(server.baseUrl, {
        mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'],
      })).resolves.toMatchObject({ url: expect.objectContaining({ protocol: 'http:' }) })
      await expect(authorizeComfyTarget('https://comfy.example/api', {
        mode: 'allowlist', allowedHosts: ['comfy.example'], allowedCidrs: [],
      }, async () => [{ address: '203.0.113.10', family: 4 }])).resolves.toMatchObject({
        url: expect.objectContaining({ hostname: 'comfy.example' }),
      })
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

  it('REQ-COMFYUI-AC-02 imports arbitrary image/video API Format mappings, uploads, and outputs', async () => {
    for (const mediaType of ['image', 'video'] as const) {
      const run = await startExecution(mediaType)
      try {
        const result = await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
        expect(result).toMatchObject({ outcome: 'completed', primary: { mediaType, primary: true } })
        const upload = run.server.server.requests.find((entry) => entry.path.endsWith('/upload/image'))
        const prompt = run.server.server.requests.find((entry) => entry.path.endsWith('/prompt'))
        expect(upload?.body.byteLength).toBeGreaterThan((mediaType === 'image' ? PNG : MP4).byteLength)
        expect(prompt?.body.toString('utf8')).toContain('RAW_PROMPT_DO_NOT_LOG')
        expect(prompt?.body.toString('utf8')).toContain('uploaded-1')
        expect(prompt?.body.toString('utf8')).not.toContain('${prompt}')
        expect(run.aggregate.request.outputRefs).toEqual([
          expect.objectContaining({ mediaType, primary: true, storageKey: expect.any(String) }),
        ])
      } finally {
        await run.server.close()
      }
    }
  })

  it('REQ-COMFYUI-AC-03 resolves task override, project Comfy default, specialized model, user default, and fixed version', async () => {
    const binding: Record<string, unknown> = {
      imageWorkflowId: 'project-workflow', imageWorkflowVersionId: 'project-version-fixed',
      videoWorkflowId: 'project-video-workflow', videoWorkflowVersionId: 'project-video-version-fixed',
    }
    const project: Record<string, unknown> = {
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
      { target: delegates.comfyWorkflow, key: 'findMany', value: async (input: {
        where: { id: { in: string[] }; userId: string }
      }) => input.where.id.in.map((id) => {
        const mediaType = id.includes('video') ? 'video' : 'image'
        const versionId = `${id}-version-fixed`
        return {
          id,
          userId: input.where.userId,
          status: 'published',
          mediaType,
          currentVersionId: versionId,
          currentVersion: {
            id: versionId,
            purpose: 'generation',
            publishedAt: new Date('2026-01-01T00:00:00.000Z'),
            contentHash: `${id}-content-hash`,
            lastSuccessfulTestAt: new Date('2026-01-01T00:00:00.000Z'),
            lastTestConnection: { userId: input.where.userId },
          },
        }
      }) },
      { target: delegates.comfyWorkflowVersion, key: 'findFirst', value: async (input: {
        where: { id: string; workflowId: string }
      }) => ({
        id: input.where.id,
        contentHash: `${input.where.workflowId}-content-hash`,
      }) },
    ], async () => {
      const task = await getProjectModelConfig('project-a', 'user-a', {
        imageModel: 'comfyui::task-workflow', videoModel: 'comfyui::task-video-workflow',
      })
      expect(task.storyboardModel).toBe('comfyui::task-workflow')
      expect(task.comfyImageWorkflowVersionId).toBe('task-workflow-version-fixed')
      expect(task.videoModel).toBe('comfyui::task-video-workflow')
      expect(task.comfyVideoWorkflowVersionId).toBe('task-video-workflow-version-fixed')
      const projectDefault = await getProjectModelConfig('project-a', 'user-a')
      expect(projectDefault.storyboardModel).toBe('comfyui::project-workflow')
      expect(projectDefault.comfyImageWorkflowVersionId).toBe('project-version-fixed')
      expect(projectDefault.videoModel).toBe('comfyui::project-video-workflow')
      expect(projectDefault.comfyVideoWorkflowVersionId).toBe('project-video-version-fixed')
    })
  })

  it('REQ-COMFYUI-AC-04 copies image/video outputs to storage and returns them through existing media flows', async () => {
    const delegates = prisma as unknown as Record<string, Record<string, unknown>>
    for (const mediaType of ['image', 'video'] as const) {
      const run = await startExecution(mediaType)
      try {
        const result = await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
        expect(result).toMatchObject({ outcome: 'completed', primary: { mediaType } })
        const stored = run.aggregate.request.outputRefs?.find((item) => 'storageKey' in item)
        if (!stored || !('storageKey' in stored)) throw new Error('missing stored output')
        expect(run.storage.objects.get(stored.storageKey)?.bytes)
          .toEqual(mediaType === 'image' ? PNG : MP4)
        await withPrismaMethods([
          { target: delegates.comfyGenerationRequest, key: 'findFirst', value: async () => ({
            status: 'completed', outputRefs: run.aggregate.request.outputRefs, errorMessage: null,
          }) },
        ], async () => {
          const flow = await pollComfyGenerationRequest({
            requestId: run.aggregate.request.id, userId: 'user-a', mediaType,
          })
          expect(flow).toMatchObject({
            status: 'completed', resultUrl: stored.url,
            ...(mediaType === 'image' ? { imageUrl: stored.url } : { videoUrl: stored.url }),
          })
        })
      } finally {
        await run.server.close()
      }
    }
  })

  it('REQ-COMFYUI-AC-05 prefers a compatible idle LRU instance and enforces concurrency one', async () => {
    const requests: ComfySchedulableRequest[] = [
      { id: 'fifo-first', userId: 'user-a', workflowVersionId: 'version-a', status: 'waiting_capacity', queuedAt: new Date(0), priority: 1 },
      { id: 'fifo-second', userId: 'user-a', workflowVersionId: 'version-a', status: 'waiting_capacity', queuedAt: new Date(1), priority: 1 },
    ]
    const connections: ComfySchedulableConnection[] = [
      { id: 'idle-incompatible', userId: 'user-a', enabled: true, lastAssignedAt: null },
      { id: 'recent', userId: 'user-a', enabled: true, lastAssignedAt: new Date(10) },
      { id: 'least-recent', userId: 'user-a', enabled: true, lastAssignedAt: new Date(5) },
    ]
    const leases = new Set<string>()
    const active = new Map<string, string>()
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
      readCachedHealth: async () => ({ state: 'online_idle' }),
      checkCachedCompatibility: async (connectionId) => connectionId !== 'idle-incompatible',
      acquireLease: async ({ connectionId }) => {
        if (leases.has(connectionId)) return false
        leases.add(connectionId); return true
      },
      releaseLease: async ({ connectionId }) => leases.delete(connectionId),
      makeWaitingIfBlocked: async () => true, markBlockedIfEligible: async () => true,
      failIncompatibleIfEligible: async () => true,
      assignIfEligible: (input) => assignComfyRequestWithStore(input, assignmentStore),
    }
    await expect(scheduleNextComfyRequest('user-a', dependencies, { newLeaseId: () => 'lease-1' }))
      .resolves.toMatchObject({ outcome: 'leased', requestId: 'fifo-first', connectionId: 'least-recent' })
    const directBusy = await assignComfyRequestWithStore({
      requestId: 'fifo-second', userId: 'user-a', connectionId: 'least-recent', leaseId: 'lease-2',
      leaseExpiresAt: new Date(100), assignedAt: new Date(20),
    }, assignmentStore)
    expect(directBusy).toBe('connection_busy')
  })

  it('REQ-COMFYUI-AC-06 keeps requests in waoowaoo when all compatible instances are busy', async () => {
    const server = new AcceptanceComfyServer()
    server.running = [[0, 'existing-owned-prompt']]
    server.pending = [[1, 'existing-pending-prompt']]
    await server.start()
    const before = await server.client().getQueue()
    let assignments = 0
    try {
      const result = await scheduleNextComfyRequest('user-a', {
        listSchedulableRequests: async () => [{
          id: 'waiting-request', userId: 'user-a', workflowVersionId: 'version-fixed',
          status: 'waiting_capacity', queuedAt: new Date(0), priority: 0,
        }],
        listOwnedEnabledConnections: async () => [{
          id: 'busy-compatible', userId: 'user-a', enabled: true, lastAssignedAt: null,
        }],
        readCachedHealth: async () => ({ state: 'online_busy_owned' }),
        checkCachedCompatibility: async () => true,
        acquireLease: async () => true, releaseLease: async () => true,
        makeWaitingIfBlocked: async () => true, markBlockedIfEligible: async () => true,
        failIncompatibleIfEligible: async () => true,
        assignIfEligible: async () => { assignments += 1; return 'assigned' },
      })
      expect(result).toEqual({ outcome: 'waiting_capacity', requestId: 'waiting-request' })
      expect(assignments).toBe(0)
      expect(server.promptCount).toBe(0)
      expect(await server.client().getQueue()).toEqual(before)
    } finally {
      await server.close()
    }
  })

  it('REQ-COMFYUI-AC-07 treats a manual prompt as external busy and makes no assignment', async () => {
    const server = new AcceptanceComfyServer()
    server.running = [[0, 'manual-prompt']]
    await server.start()
    const client = server.client()
    let assignments = 0
    try {
      const monitored = await monitorComfyHealth({
        connectionId: 'connection-a', checkedAt: new Date(), ttlMs: 1_000,
      }, {
        authorize: async () => undefined, getSystemStats: () => client.getSystemStats(),
        getQueue: () => client.getQueue(), hasLease: async () => false,
        checkCompatibility: async () => { throw new Error('not requested') },
        cacheEval: async () => 1,
      })
      expect(monitored.health.state).toBe('online_busy_external')
      const result = await scheduleNextComfyRequest('user-a', {
        listSchedulableRequests: async () => [{
          id: 'waiting-request', userId: 'user-a', workflowVersionId: 'version-fixed',
          status: 'waiting_capacity', queuedAt: new Date(0), priority: 0,
        }],
        listOwnedEnabledConnections: async () => [{
          id: 'connection-a', userId: 'user-a', enabled: true, lastAssignedAt: null,
        }],
        readCachedHealth: async () => ({ state: monitored.health.state }),
        checkCachedCompatibility: async () => true,
        acquireLease: async () => true, releaseLease: async () => true,
        makeWaitingIfBlocked: async () => true, markBlockedIfEligible: async () => true,
        failIncompatibleIfEligible: async () => true,
        assignIfEligible: async () => { assignments += 1; return 'assigned' },
      })
      expect(result.outcome).toBe('waiting_capacity')
      expect(assignments).toBe(0)
      expect(server.promptCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('REQ-COMFYUI-AC-08 avoids duplicate execution across restart, WS loss, cancel, and transfer failure', async () => {
    const restart = await startExecution('image')
    restart.server.websocketMode = 'disconnect'
    restart.server.historyVisible = false
    try {
      await expect(dispatchComfyRequest(restart.aggregate.request.id, restart.execution.dependencies()))
        .resolves.toEqual({ outcome: 'reconciling', promptId: 'prompt-1' })
      expect(restart.server.promptCount).toBe(1)
      restart.server.historyVisible = true
      const recovery = new InMemoryComfyExecution(
        restart.server.client(), restart.storage, restart.aggregate, restart.telemetry,
      )
      await expect(reconcileComfyRequest(restart.aggregate.request.id, {
        loadContext: recovery.dependencies().loadContext, verifyLeaseOwner: async () => true,
        getQueue: () => restart.server.client().getQueue(),
        getHistory: (promptId) => restart.server.client().getHistory(promptId),
        recordAttemptAbsence: async () => ({ outcome: 'reconciling', checkCount: 1 }),
        deleteQueuedPrompt: (promptId) => restart.server.client().deleteQueuedPrompt(promptId),
        persistRecoveredCancellation: async () => true, persistRecoveredDiagnostics: async () => true,
        releaseLease: async () => true,
        persistRecoveredState: async ({ status, outputs }) => {
          restart.aggregate.request.status = status
          if (outputs) restart.aggregate.request.outputRefs = outputs
          return true
        },
      })).resolves.toMatchObject({ outcome: 'transferring' })
      await expect(dispatchComfyRequest(restart.aggregate.request.id, recovery.dependencies()))
        .resolves.toMatchObject({ outcome: 'completed' })
      expect(restart.server.promptCount).toBe(1)
    } finally {
      await restart.server.close()
    }

    const disconnected = await startExecution('image')
    disconnected.server.websocketMode = 'disconnect'
    try {
      await expect(dispatchComfyRequest(disconnected.aggregate.request.id, disconnected.execution.dependencies()))
        .resolves.toMatchObject({ outcome: 'completed' })
      expect(disconnected.server.promptCount).toBe(1)
    } finally {
      await disconnected.server.close()
    }

    const cancelServer = new AcceptanceComfyServer()
    cancelServer.pending = [[0, 'owned-prompt'], [1, 'manual-prompt']]
    cancelServer.installHistoryRoute('owned-prompt')
    await cancelServer.start()
    const cancelClient = cancelServer.client()
    const cancelRequest = {
      id: 'request-a', userId: 'user-a', status: 'submitted' as const,
      connectionId: 'connection-a', leaseId: 'lease-a', promptId: 'owned-prompt',
    }
    const cancellationDependencies = {
      loadOwnedRequest: async () => cancelRequest, cancelLocal: async () => true,
      verifyLeaseOwner: async () => true, requestCancellation: async () => 'requested' as const,
      getQueue: () => cancelClient.getQueue(), getHistory: (promptId: string) => cancelClient.getHistory(promptId),
      isAbsenceConclusive: async () => true,
      deleteQueuedPrompt: (promptId: string) => cancelClient.deleteQueuedPrompt(promptId),
      release: async () => true, markCanceledOwned: async () => true,
    }
    try {
      await expect(cancelComfyRequest('request-a', 'user-a', cancellationDependencies))
        .resolves.toEqual({ outcome: 'canceled' })
      expect(cancelServer.pending).toEqual([[1, 'manual-prompt']])
      cancelServer.pending = []
      cancelServer.running = [[0, 'owned-prompt']]
      await expect(cancelComfyRequest('request-a', 'user-a', cancellationDependencies))
        .resolves.toEqual({ outcome: 'canceling' })
      expect(cancelServer.interruptCount).toBe(0)
      expect(cancelServer.promptCount).toBe(0)
    } finally {
      await cancelServer.close()
    }

    const transfer = await startExecution('image', 1)
    try {
      await expect(dispatchComfyRequest(transfer.aggregate.request.id, transfer.execution.dependencies()))
        .resolves.toMatchObject({ outcome: 'reconciling', promptId: 'prompt-1' })
      const retried = new InMemoryComfyExecution(
        transfer.server.client(), transfer.storage, transfer.aggregate, transfer.telemetry,
      )
      await expect(dispatchComfyRequest(transfer.aggregate.request.id, retried.dependencies()))
        .resolves.toMatchObject({ outcome: 'completed' })
      expect(transfer.server.promptCount).toBe(1)
    } finally {
      await transfer.server.close()
    }
  })

  it('records zero billing, progress, metrics, and redacted operational logs', async () => {
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

  it('REQ-COMFYUI-AC-09 defaults to trusted while preserving allowlist and metadata protections', async () => {
    const server = new AcceptanceComfyServer()
    server.requiredAuthorization = 'Bearer required-token'
    await server.start()
    try {
      await expect(server.client({ type: 'bearer', token: 'required-token' }).getSystemStats())
        .resolves.toMatchObject({ system: { comfyui_version: 'fake-1' } })
      await expect(server.client({ type: 'none' }).getSystemStats())
        .rejects.toMatchObject({ code: COMFY_ERROR_CODE.AUTH_FAILED })
      expect(readComfyRuntimeConfig({})).toMatchObject({
        enabled: true,
        networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
      })
      expect(readComfyRuntimeConfig({
        COMFYUI_NETWORK_MODE: 'allowlist',
        COMFYUI_ALLOWED_HOSTS: 'comfy.example.com',
      }).networkPolicy.mode).toBe('allowlist')
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

  it('REQ-COMFYUI-AC-10 denies cross-user connections, workflows, tasks, and outputs', async () => {
    const run = await startExecution('image')
    try {
      await dispatchComfyRequest(run.aggregate.request.id, run.execution.dependencies())
      const output = run.aggregate.request.outputRefs?.find((item) => 'storageKey' in item)
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
      const connectionResult = await scheduleNextComfyRequest('user-a', {
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
        failIncompatibleIfEligible: async () => true,
      })
      expect(connectionResult.outcome).toBe('blocked_no_compatible_instance')
      expect(leaseAttempts).toBe(0)
    } finally {
      await run.server.close()
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
    const workflowFile = await writeContractWorkflow()
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
      expect(server.historyDeleteCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('contract cleanup deletes its timed-out pending prompt and preserves manual queue work', async () => {
    const workflowFile = await writeContractWorkflow()
    const server = new AcceptanceComfyServer()
    server.submitQueueMode = 'pending'
    server.historyVisible = false
    server.pending.push([99, 'manual-prompt'])
    server.installDynamicHistoryRoutes()
    await server.start()
    try {
      await expect(runComfyContractCheck({
        baseUrl: server.baseUrl, workflowFile, auth: { type: 'none' }, timeoutMs: 25,
        networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      })).rejects.toThrow('ComfyUI contract workflow timed out')
      expect(server.pending).toEqual([[99, 'manual-prompt']])
      expect(server.interruptCount).toBe(0)
      expect(server.historyDeleteCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('contract cleanup deletes its prompt after history failure without touching manual work', async () => {
    const workflowFile = await writeContractWorkflow()
    const server = new AcceptanceComfyServer()
    server.submitQueueMode = 'pending'
    server.historyStatus = 500
    server.pending.push([99, 'manual-prompt'])
    server.installDynamicHistoryRoutes()
    await server.start()
    try {
      await expect(runComfyContractCheck({
        baseUrl: server.baseUrl, workflowFile, auth: { type: 'none' }, timeoutMs: 100,
        networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      })).rejects.toMatchObject({ code: COMFY_ERROR_CODE.CONNECTION_OFFLINE })
      expect(server.pending).toEqual([[99, 'manual-prompt']])
      expect(server.interruptCount).toBe(0)
      expect(server.historyDeleteCount).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('contract cleanup never globally interrupts a running prompt and preserves manual work', async () => {
    const workflowFile = await writeContractWorkflow()
    const server = new AcceptanceComfyServer()
    server.submitQueueMode = 'running'
    server.downloadStatus = 500
    server.running.push([99, 'manual-prompt'])
    server.installDynamicHistoryRoutes()
    await server.start()
    try {
      const output: string[] = []
      await expect(runComfyContractCheck({
        baseUrl: server.baseUrl, workflowFile, auth: { type: 'none' }, timeoutMs: 100,
        networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      }, { write: (line) => output.push(line) }))
        .rejects.toMatchObject({ code: COMFY_ERROR_CODE.OUTPUT_TRANSFER_FAILED })
      expect(server.running).toEqual([[99, 'manual-prompt'], [1, 'prompt-1']])
      expect(server.interruptCount).toBe(0)
      expect(server.historyDeleteCount).toBe(1)
      expect(output).toContain(JSON.stringify({
        ok: false, event: 'cleanup_pending', stage: 'running_prompt', action: 'operator_required',
      }))
    } finally {
      await server.close()
    }
  })

  it('contract checker rejects upload-dependent bundles before submitting a prompt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comfy-contract-upload-'))
    temporaryPaths.push(directory)
    const workflowFile = join(directory, 'workflow.json')
    await writeFile(workflowFile, JSON.stringify({
      graph: { '1': { class_type: 'LoadImage', inputs: { image: '${input}' } } },
      variableDefinitions: [{ name: 'input', type: 'image_ref', required: true }],
      bindings: [{
        nodeId: '1', inputPath: 'image', variable: 'input', valueType: 'image_ref', transform: 'filename',
      }],
      variables: { input: { storageKey: 'users/user-a/input.png' } },
      outputs: [{ name: 'primary', nodeId: '1', fieldPath: 'images', mediaType: 'image', primary: true }],
    }))
    const server = new AcceptanceComfyServer()
    await server.start()
    try {
      await expect(runComfyContractCheck({
        baseUrl: server.baseUrl, workflowFile, auth: { type: 'none' }, timeoutMs: 100,
        networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      })).rejects.toThrow('does not support uploaded inputs')
      expect(server.promptCount).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('contract cleanup failure stays sanitized and never replaces the original execution error', async () => {
    const workflowFile = await writeContractWorkflow()
    const server = new AcceptanceComfyServer()
    server.submitQueueMode = 'pending'
    server.historyVisible = false
    server.installDynamicHistoryRoutes()
    server.server.override('/proxy/comfy/queue', (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        response.statusCode = 500
        response.end(JSON.stringify({ secret: 'MUST_NOT_LEAK' }))
      } else {
        response.end(JSON.stringify({ queue_running: server.running, queue_pending: server.pending }))
      }
    })
    await server.start()
    try {
      const output: string[] = []
      await expect(runComfyContractCheck({
        baseUrl: server.baseUrl, workflowFile, auth: { type: 'none' }, timeoutMs: 25,
        networkPolicy: { mode: 'allowlist', allowedHosts: [], allowedCidrs: ['127.0.0.1/32'] },
      }, { write: (line) => output.push(line) })).rejects.toThrow('ComfyUI contract workflow timed out')
      expect(output.map((line) => JSON.parse(line))).toContainEqual({
        ok: false, event: 'cleanup_failed', stage: 'delete_pending',
        code: COMFY_ERROR_CODE.CONNECTION_OFFLINE,
      })
      expect(JSON.stringify(output)).not.toContain('MUST_NOT_LEAK')
    } finally {
      await server.close()
    }
  })
})
