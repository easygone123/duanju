import { beforeEach, describe, expect, it, vi } from 'vitest'

const workflowFindFirst = vi.hoisted(() => vi.fn())
const requestCreate = vi.hoisted(() => vi.fn())
const generationFindFirst = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({
  prisma: {
    comfyWorkflow: { findFirst: workflowFindFirst },
    comfyGenerationRequest: { findFirst: generationFindFirst },
    userPreference: { findUnique: vi.fn(async () => null) },
  },
}))

vi.mock('@/lib/comfyui/request-service', () => ({
  createComfyGenerationRequest: requestCreate,
}))

import { resolveModelSelection } from '@/lib/api-config'
import { getTaskStageLabel } from '@/lib/task/progress-message'
import enProgress from '../../../messages/en/progress.json'
import zhProgress from '../../../messages/zh/progress.json'
import {
  submitComfyImageGeneration,
  submitComfyVideoGeneration,
  pollComfyGenerationRequest,
} from '@/lib/comfyui/provider'
import {
  resolveComfyStorageKeyFromMediaValue,
  resolveOwnedComfyMediaRefFromValue,
} from '@/lib/comfyui/media-ownership'

describe('ComfyUI native provider routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workflowFindFirst.mockResolvedValue({
      id: 'wf-image',
      userId: 'user-1',
      mediaType: 'image',
      status: 'published',
      currentVersionId: 'version-1',
      currentVersion: { id: 'version-1', publishedAt: new Date() },
    })
    requestCreate.mockResolvedValue({ id: 'request-1' })
  })

  it('selects an owned published ComfyUI workflow with the requested media type', async () => {
    await expect(resolveModelSelection('user-1', 'comfyui::wf-image', 'image')).resolves.toEqual({
      provider: 'comfyui',
      modelId: 'wf-image',
      modelKey: 'comfyui::wf-image',
      mediaType: 'image',
    })
    expect(workflowFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'wf-image',
        userId: 'user-1',
        mediaType: 'image',
        status: 'published',
      },
    }))
  })

  it.each([
    ['cross-user', null],
    ['unpublished', null],
    ['wrong media type', null],
  ])('fails closed for %s workflow selection', async (_label, record) => {
    workflowFindFirst.mockResolvedValueOnce(record)
    await expect(resolveModelSelection('user-1', 'comfyui::wf-image', 'image'))
      .rejects.toThrow('MODEL_NOT_FOUND: comfyui::wf-image is not enabled for image')
  })

  it('does not treat provider names that merely contain comfyui as native routing', async () => {
    await expect(resolveModelSelection('user-1', 'comfyui:remote::wf-image', 'image'))
      .rejects.toThrow('MODEL_NOT_FOUND')
    expect(workflowFindFirst).not.toHaveBeenCalled()
  })

  it('creates an image request and returns a standard async external ID', async () => {
    await expect(submitComfyImageGeneration({
      userId: 'user-1',
      workflowId: 'wf-image',
      workflowVersionId: 'version-pinned',
      prompt: 'rain',
      context: {
        projectId: 'project-1',
        taskId: 'task-1',
        invocationKey: 'task-1:image:0',
      },
      variables: { seed: 42 },
    })).resolves.toEqual({
      success: true,
      async: true,
      externalId: 'COMFY:IMAGE:request-1',
    })
    expect(requestCreate).toHaveBeenCalledWith({
      invocationKey: 'task-1:image:0',
      userId: 'user-1',
      projectId: 'project-1',
      taskId: 'task-1',
      mediaType: 'image',
      workflowId: 'wf-image',
      workflowVersionId: 'version-pinned',
      variables: { prompt: 'rain', seed: 42 },
    })
  })

  it('creates a video request with standard video variables and external ID', async () => {
    requestCreate.mockResolvedValueOnce({ id: 'request-video' })
    await expect(submitComfyVideoGeneration({
      userId: 'user-1',
      workflowId: 'wf-video',
      prompt: 'move',
      context: {
        projectId: 'project-1',
        taskId: 'task-2',
        invocationKey: 'task-2:video:0',
      },
      variables: { duration_seconds: 5, fps: 24 },
    })).resolves.toEqual({
      success: true,
      async: true,
      externalId: 'COMFY:VIDEO:request-video',
    })
    expect(requestCreate).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: 'video',
      workflowId: 'wf-video',
      variables: { prompt: 'move', duration_seconds: 5, fps: 24 },
    }))
  })

  it('uses stable per-invocation keys for multiple candidates and retries', async () => {
    requestCreate.mockImplementation(async (input: { invocationKey: string }) => ({
      id: input.invocationKey.endsWith(':0') ? 'candidate-0' : 'candidate-1',
    }))
    const base = {
      userId: 'user-1', workflowId: 'wf-image', prompt: 'rain',
      variables: {},
    }
    const first = await submitComfyImageGeneration({
      ...base,
      context: { projectId: 'project-1', taskId: 'task-1', invocationKey: 'task-1:panel:p1:candidate:0' },
    })
    const second = await submitComfyImageGeneration({
      ...base,
      context: { projectId: 'project-1', taskId: 'task-1', invocationKey: 'task-1:panel:p1:candidate:1' },
    })
    const retry = await submitComfyImageGeneration({
      ...base,
      context: { projectId: 'project-1', taskId: 'task-1', invocationKey: 'task-1:panel:p1:candidate:0' },
    })
    expect(first.externalId).toBe('COMFY:IMAGE:candidate-0')
    expect(second.externalId).toBe('COMFY:IMAGE:candidate-1')
    expect(retry.externalId).toBe(first.externalId)
  })

  it('resolves an owner-scoped project media value to an opaque ComfyUI ref', async () => {
    const findFirst = vi.fn(async () => ({ storageKey: 'projects/p1/input.png', mimeType: 'image/png' }))
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', value: 'https://signed/input', mediaType: 'image',
    }, {
      resolveStorageKey: vi.fn(async () => 'projects/p1/input.png'),
      findFirst,
    })).resolves.toEqual({ storageKey: 'projects/p1/input.png', mimeType: 'image/png' })
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        storageKey: 'projects/p1/input.png',
        mimeType: { startsWith: 'image/' },
      }),
    }))
  })

  it.each([
    ['/api/storage/sign?key=projects%2Fp1%2Finput.png&expires=3600', 'projects/p1/input.png'],
  ])('extracts an opaque key from the real signed-storage route %s', async (value, expected) => {
    await expect(resolveComfyStorageKeyFromMediaValue(value)).resolves.toBe(expected)
  })

  it('uses the real signed-route parser before the owner/project/mime database gate', async () => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Fowned.png&expires=3600',
    }, {
      findFirst: vi.fn(async () => ({ storageKey: 'images/owned.png', mimeType: 'image/png' })),
    })).resolves.toEqual({ storageKey: 'images/owned.png', mimeType: 'image/png' })
  })

  it('rejects a real signed-route key when the owner/project database gate does not match', async () => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'other-user', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Fowned.png&expires=3600',
    }, {
      findFirst: vi.fn(async () => null),
    })).resolves.toBeNull()
  })

  it.each([
    '/api/storage/sign',
    '/api/storage/sign?key=one.png&key=two.png',
    '/api/storage/sign?key=images%2Fowned.png#fragment',
    '/api/storage/sign?key=images%2Fowned.png&token=secret',
    'https://evil.example/api/storage/sign?key=images%2Fowned.png',
    '//evil.example/api/storage/sign?key=images%2Fowned.png',
    '/api/storage/sign?key=..%2Fsecret.png',
    '/api/storage/sign?key=https%3A%2F%2Fevil.example%2Finput.png',
  ])('rejects malformed or spoofed signed-storage media value %s', async (value) => {
    await expect(resolveComfyStorageKeyFromMediaValue(value)).resolves.toBeNull()
  })

  it.each([
    ['external URL', 'https://evil.example/input.png', null],
    ['cross-user media', '/api/storage/sign?key=other/input.png', 'other/input.png'],
    ['wrong media type', '/api/storage/sign?key=video/input.mp4', 'video/input.mp4'],
  ])('fails closed for %s', async (_label, value, storageKey) => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', value, mediaType: 'image',
    }, {
      resolveStorageKey: vi.fn(async () => storageKey),
      findFirst: vi.fn(async () => null),
    })).resolves.toBeNull()
  })

  it.each([
    ['waiting_capacity', 'comfy_waiting_capacity', true],
    ['blocked_no_compatible_instance', 'comfy_checking_compatibility', true],
    ['leased', 'comfy_checking_compatibility', false],
    ['uploading', 'comfy_uploading_inputs', false],
    ['submitting', 'comfy_submitting', false],
    ['running', 'comfy_running', false],
    ['transferring', 'comfy_transferring_outputs', false],
    ['reconciling', 'comfy_reconciling', false],
  ] as const)('maps %s to a stable internal stage', async (status, stage, waitingForCapacity) => {
    generationFindFirst.mockResolvedValueOnce({ status, outputRefs: null, errorMessage: null })
    await expect(pollComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', mediaType: 'image',
    })).resolves.toEqual({ status: 'pending', stage, waitingForCapacity })
  })

  it('returns the primary URL and all durable outputs without leaking other media', async () => {
    generationFindFirst.mockResolvedValueOnce({
      status: 'completed', errorMessage: null,
      outputRefs: [
        { mediaType: 'image', url: 'https://store/one.png', storageKey: 'one', primary: false },
        { mediaType: 'image', url: 'https://store/two.png', storageKey: 'two', primary: true },
        { mediaType: 'video', url: 'https://store/not-image.mp4', storageKey: 'x', primary: true },
      ],
    })
    await expect(pollComfyGenerationRequest({
      requestId: 'request-1', userId: 'user-1', mediaType: 'image',
    })).resolves.toEqual({
      status: 'completed',
      stage: 'comfy_transferring_outputs',
      waitingForCapacity: false,
      resultUrl: 'https://store/two.png',
      resultStorageKey: 'two',
      imageUrl: 'https://store/two.png',
      resultUrls: ['https://store/one.png', 'https://store/two.png'],
      resultStorageKeys: ['one', 'two'],
    })
    expect(generationFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'request-1', userId: 'user-1', mediaType: 'image' },
    }))
  })

  it('fails closed when the durable request is not owned by the polling user', async () => {
    generationFindFirst.mockResolvedValueOnce(null)
    await expect(pollComfyGenerationRequest({
      requestId: 'request-1', userId: 'other-user', mediaType: 'image',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('publishes all seven stable stages in both locales', () => {
    const stages = {
      comfy_waiting_capacity: 'comfyWaitingCapacity',
      comfy_checking_compatibility: 'comfyCheckingCompatibility',
      comfy_uploading_inputs: 'comfyUploadingInputs',
      comfy_submitting: 'comfySubmitting',
      comfy_running: 'comfyRunning',
      comfy_transferring_outputs: 'comfyTransferringOutputs',
      comfy_reconciling: 'comfyReconciling',
    } as const
    for (const [stage, key] of Object.entries(stages)) {
      expect(getTaskStageLabel(stage)).toBe(`progress.stage.${key}`)
      expect(enProgress.stage[key]).toBeTruthy()
      expect(zhProgress.stage[key]).toBeTruthy()
    }
  })
})
