import { beforeEach, describe, expect, it, vi } from 'vitest'

const pollMock = vi.hoisted(() => vi.fn())
const progressMock = vi.hoisted(() => vi.fn())
const heartbeatMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('@/lib/async-poll', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/async-poll')>(),
  pollAsyncTask: pollMock,
}))
vi.mock('@/lib/task/service', () => ({
  isTaskActive: vi.fn(async () => true),
  touchTaskHeartbeat: heartbeatMock,
  trySetTaskExternalId: vi.fn(async () => true),
}))
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: progressMock }))
vi.mock('@/lib/prisma', () => ({ prisma: { task: { findUnique: vi.fn(async () => null) } } }))

import { buildComfyProviderInvocation, waitExternalResult } from '@/lib/workers/utils'

describe('ComfyUI worker polling deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pollMock.mockReset()
    progressMock.mockReset()
  })

  it('polls the current result before yielding capacity without reporting an execution timeout', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    pollMock
      .mockResolvedValueOnce({ status: 'pending', stage: 'comfy_running', waitingForCapacity: false })
      .mockResolvedValueOnce({ status: 'pending', stage: 'comfy_waiting_capacity', waitingForCapacity: true })
      .mockResolvedValueOnce({
        status: 'completed', stage: 'comfy_transferring_outputs', waitingForCapacity: false,
        resultUrl: 'https://store/result.png',
      })
    progressMock.mockImplementationOnce(async () => { now = 200 })

    const moveToDelayed = vi.fn(async () => undefined)
    const updateData = vi.fn(async () => undefined)
    const job = {
      data: { taskId: 'task-1', projectId: 'project-1', userId: 'user-1' },
      token: 'worker-token', moveToDelayed, updateData,
    } as never
    await expect(waitExternalResult(job, 'COMFY:IMAGE:req-1', 'user-1', {
      timeoutMs: 100,
      intervalMs: 0,
      capacityWaitBaseMs: 2_000,
      capacityWaitJitter: () => 0,
    })).rejects.toMatchObject({ name: 'DelayedError' })
    expect(pollMock).toHaveBeenCalledTimes(2)
    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({
      comfyCapacityResume: {
        version: 1,
        taskId: 'task-1',
        externalId: 'COMFY:IMAGE:req-1',
      },
    }))
    expect(heartbeatMock).toHaveBeenCalledWith('task-1')
    expect(moveToDelayed).toHaveBeenCalledWith(2_200, 'worker-token')
  })

  it.each([
    ['comfy_waiting_capacity', 'IMAGE', 20],
    ['comfy_checking_compatibility', 'VIDEO', 4],
  ] as const) (
    'yields %s immediately so capacity wait cannot occupy all %s worker slots',
    async (stage, mediaType, count) => {
      const now = 10_000
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      for (let index = 0; index < count; index += 1) {
        pollMock.mockResolvedValueOnce({ status: 'pending', stage, waitingForCapacity: true })
        const moveToDelayed = vi.fn(async () => undefined)
        const updateData = vi.fn(async () => undefined)
        const job = {
          data: { taskId: `task-${index}`, projectId: 'project-1', userId: 'user-1' },
          token: `token-${index}`, moveToDelayed, updateData,
        } as never
        await expect(waitExternalResult(job, `COMFY:${mediaType}:req-${index}`, 'user-1', {
          capacityWaitBaseMs: 1_000, capacityWaitJitter: () => 0,
        })).rejects.toMatchObject({ name: 'DelayedError' })
        expect(moveToDelayed).toHaveBeenCalledWith(11_000, `token-${index}`)
      }
    },
  )

  it('continues polling execution states without yielding', async () => {
    pollMock
      .mockResolvedValueOnce({ status: 'pending', stage: 'comfy_running', waitingForCapacity: false })
      .mockResolvedValueOnce({ status: 'completed', resultUrl: 'https://store/result.png' })
    const moveToDelayed = vi.fn(async () => undefined)
    const updateData = vi.fn(async () => undefined)
    const job = {
      data: {
        taskId: 'task-1', projectId: 'project-1', userId: 'user-1',
        comfyCapacityResume: {
          version: 1, taskId: 'task-1', externalId: 'COMFY:IMAGE:req-1',
        },
      },
      token: 'token', moveToDelayed, updateData,
    } as never
    await expect(waitExternalResult(job, 'COMFY:IMAGE:req-1', 'user-1', {
      intervalMs: 0,
    })).resolves.toMatchObject({ url: 'https://store/result.png' })
    expect(moveToDelayed).not.toHaveBeenCalled()
    expect(updateData).toHaveBeenCalledWith(expect.not.objectContaining({ comfyCapacityResume: expect.anything() }))
  })

  it('maps owned edit and first/last-frame inputs without exposing source URLs', async () => {
    const resolveStorageKey = vi.fn(async (value: unknown) => `owned/${String(value)}.png`)
    const findFirst = vi.fn(async (input: Record<string, unknown>) => {
      const storageKey = (input.where as { storageKey: string }).storageKey
      return { storageKey, mimeType: 'image/png' }
    })
    await expect(buildComfyProviderInvocation({
      userId: 'user-1', projectId: 'project-1', taskId: 'task-1',
      modelKey: 'comfyui::wf-video', invocationKey: 'task-1:panel:p1:video',
      inputImages: ['edit'], sourceImage: 'source', firstFrame: 'first', lastFrame: 'last',
    }, { resolveStorageKey, findFirst })).resolves.toEqual({
      context: {
        projectId: 'project-1', taskId: 'task-1', invocationKey: 'task-1:panel:p1:video',
      },
      inputImages: [{ storageKey: 'owned/edit.png', mimeType: 'image/png' }],
      sourceImage: { storageKey: 'owned/source.png', mimeType: 'image/png' },
      firstFrame: { storageKey: 'owned/first.png', mimeType: 'image/png' },
      lastFrame: { storageKey: 'owned/last.png', mimeType: 'image/png' },
    })
  })

  it('fails closed when ComfyUI media is external or not owner-scoped', async () => {
    await expect(buildComfyProviderInvocation({
      userId: 'user-1', projectId: 'project-1', taskId: 'task-1',
      modelKey: 'comfyui::wf-image', invocationKey: 'task-1:image:0',
      inputImages: ['https://evil.example/input.png'],
    }, {
      resolveStorageKey: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
    })).rejects.toThrow('COMFY_MEDIA_NOT_OWNED')
  })

  it('does not inspect or transform media for cloud providers', async () => {
    const resolveStorageKey = vi.fn(async () => null)
    await expect(buildComfyProviderInvocation({
      userId: 'user-1', projectId: 'project-1', taskId: 'task-1',
      modelKey: 'fal::image', invocationKey: 'task-1:image:0',
      inputImages: ['https://external.example/input.png'],
    }, { resolveStorageKey, findFirst: vi.fn(async () => null) })).resolves.toBeUndefined()
    expect(resolveStorageKey).not.toHaveBeenCalled()
  })
})
