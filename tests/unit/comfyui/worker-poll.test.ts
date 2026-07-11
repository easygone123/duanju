import { beforeEach, describe, expect, it, vi } from 'vitest'

const pollMock = vi.hoisted(() => vi.fn())
const progressMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/async-poll', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/async-poll')>(),
  pollAsyncTask: pollMock,
}))
vi.mock('@/lib/task/service', () => ({
  isTaskActive: vi.fn(async () => true),
  trySetTaskExternalId: vi.fn(async () => true),
}))
vi.mock('@/lib/workers/shared', () => ({ reportTaskProgress: progressMock }))
vi.mock('@/lib/prisma', () => ({ prisma: { task: { findUnique: vi.fn(async () => null) } } }))

import { buildComfyProviderInvocation, waitExternalResult } from '@/lib/workers/utils'

describe('ComfyUI worker polling deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('polls the current result before timing out so a return to capacity can reset the clock', async () => {
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

    const job = {
      data: { taskId: 'task-1', projectId: 'project-1', userId: 'user-1' },
    } as never
    await expect(waitExternalResult(job, 'COMFY:IMAGE:req-1', 'user-1', {
      timeoutMs: 100,
      intervalMs: 0,
    })).resolves.toMatchObject({ url: 'https://store/result.png' })
    expect(pollMock).toHaveBeenCalledTimes(3)
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
      inputImages: ['edit'], firstFrame: 'first', lastFrame: 'last',
    }, { resolveStorageKey, findFirst })).resolves.toEqual({
      context: {
        projectId: 'project-1', taskId: 'task-1', invocationKey: 'task-1:panel:p1:video',
      },
      inputImages: [{ storageKey: 'owned/edit.png', mimeType: 'image/png' }],
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
