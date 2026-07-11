import { beforeEach, describe, expect, it, vi } from 'vitest'

const pollComfyRequest = vi.hoisted(() => vi.fn())

vi.mock('@/lib/comfyui/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/comfyui/provider')>()
  return { ...actual, pollComfyGenerationRequest: pollComfyRequest }
})

import {
  advanceExternalExecutionClock,
  externalPollProgress,
  parseExternalId,
  pollAsyncTask,
  type ExternalExecutionClock,
} from '@/lib/async-poll'

describe('ComfyUI async polling', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['COMFY:IMAGE:req-1', 'IMAGE', 'req-1'],
    ['COMFY:VIDEO:req_2', 'VIDEO', 'req_2'],
  ] as const)('strictly parses %s', (externalId, type, requestId) => {
    expect(parseExternalId(externalId)).toEqual({
      provider: 'COMFY',
      type,
      requestId,
    })
  })

  it.each([
    'COMFY:AUDIO:req-1',
    'COMFY:IMAGE:',
    'COMFY:IMAGE:req:extra',
    'COMFY:IMAGE:req\n',
  ])('rejects malformed ComfyUI external ID %j', (externalId) => {
    expect(() => parseExternalId(externalId)).toThrow()
  })

  it('delegates polling with the authenticated owner and media type', async () => {
    pollComfyRequest.mockResolvedValueOnce({
      status: 'pending',
      stage: 'comfy_running',
      waitingForCapacity: false,
    })
    await expect(pollAsyncTask('COMFY:VIDEO:req-1', 'user-1')).resolves.toEqual({
      status: 'pending',
      stage: 'comfy_running',
      waitingForCapacity: false,
    })
    expect(pollComfyRequest).toHaveBeenCalledWith({
      requestId: 'req-1',
      userId: 'user-1',
      mediaType: 'video',
    })
  })

  it('does not start or consume the execution deadline while waiting for capacity', () => {
    const clock: ExternalExecutionClock = {}
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: true }, 1_000)).toBeNull()
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: true }, 91_000)).toBeNull()
    expect(clock.startedAt).toBeUndefined()
  })

  it('starts the execution deadline only after capacity waiting ends', () => {
    const clock: ExternalExecutionClock = {}
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: true }, 1_000)).toBeNull()
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: false }, 101_000)).toBe(0)
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: false }, 106_000)).toBe(5_000)
    expect(clock.startedAt).toBe(101_000)
  })

  it('resets the execution deadline when a pre-submit retry returns to capacity waiting', () => {
    const clock: ExternalExecutionClock = {}
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: false }, 1_000)).toBe(0)
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: false }, 6_000)).toBe(5_000)
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: true }, 7_000)).toBeNull()
    expect(clock.startedAt).toBeUndefined()
    expect(advanceExternalExecutionClock(clock, { waitingForCapacity: false }, 100_000)).toBe(0)
  })

  it('publishes a stable ComfyUI stage without elapsed-time fake progress', () => {
    expect(externalPollProgress({
      result: { stage: 'comfy_running' },
      executionElapsed: 1_000,
      timeoutMs: 10_000,
      progressStart: 40,
      progressEnd: 90,
    })).toEqual({ progress: 40, stage: 'comfy_running' })
    expect(externalPollProgress({
      result: { stage: 'comfy_running' },
      executionElapsed: 9_000,
      timeoutMs: 10_000,
      progressStart: 40,
      progressEnd: 90,
    })).toEqual({ progress: 40, stage: 'comfy_running' })
  })

  it('preserves elapsed progress behavior for existing cloud providers', () => {
    expect(externalPollProgress({
      result: {},
      executionElapsed: 5_000,
      timeoutMs: 10_000,
      progressStart: 40,
      progressEnd: 90,
    })).toEqual({ progress: 65, stage: 'polling_external' })
  })
})
