import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSheetTaskMutationOptions,
  sixGridStoryboardQueryKeys,
} from '@/lib/query/hooks/useSixGridStoryboard'
import { queryKeys } from '@/lib/query/keys'
import { upsertTaskTargetOverlay } from '@/lib/query/task-target-overlay'
import { TASK_TYPE } from '@/lib/task/types'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

const input = (storyboardId = 'storyboard-1') => ({
  operation: 'generate' as const,
  episodeId: 'episode-1',
  storyboardId,
})

function createAttemptAccess() {
  const attempts: Record<string, number> = {}
  return {
    nextAttempt: (storyboardId: string) => {
      const attempt = (attempts[storyboardId] ?? 0) + 1
      attempts[storyboardId] = attempt
      return attempt
    },
    currentAttempt: (storyboardId: string) => attempts[storyboardId],
  }
}

function createHarness(
  queryClient: QueryClient,
  attemptAccess = createAttemptAccess(),
  errors: Record<string, string> = { 'storyboard-2': 'keep this error' },
) {
  const options = createSheetTaskMutationOptions(
    queryClient,
    'project-1',
    'episode-1',
    (storyboardId, error) => {
      if (error) errors[storyboardId] = error
      else delete errors[storyboardId]
    },
    attemptAccess.nextAttempt,
    attemptAccess.currentAttempt,
  )
  return { errors, options }
}

afterEach(() => {
  apiFetchMock.mockReset()
})

describe('grid sheet submit mutation', () => {
  it('clears the optimistic overlay and records the actual storyboard-scoped rejection', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'provider rejected sheet' },
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const { errors, options } = createHarness(queryClient)
    const variables = input()
    const context = options.onMutate(variables)

    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      },
    })

    let requestError: unknown
    try {
      await options.mutationFn(variables)
    } catch (error) {
      requestError = error
    }
    expect(requestError).toEqual(new Error('provider rejected sheet'))
    options.onError(requestError as Error, variables, context)

    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
    expect(errors).toEqual({
      'storyboard-1': 'provider rejected sheet',
      'storyboard-2': 'keep this error',
    })
  })

  it('clears the current error, refreshes only the group and episode stage, and preserves typed task handoff', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ taskId: 'server-task-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
    const { errors, options } = createHarness(queryClient)
    const variables = input()
    const context = options.onMutate(variables)
    errors['storyboard-1'] = 'previous failure'
    upsertTaskTargetOverlay(queryClient, {
      projectId: 'project-1',
      targetType: 'NovelPromotionStoryboard',
      targetId: 'storyboard-1',
      runningTaskId: 'server-task-1',
      runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      phase: 'processing',
      intent: 'generate',
    })

    const response = await options.mutationFn(variables)
    await options.onSuccess(response, variables, context)

    expect(errors).toEqual({ 'storyboard-2': 'keep this error' })
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      sixGridStoryboardQueryKeys.group('project-1', 'episode-1', 'storyboard-1'),
      queryKeys.episodeStages('project-1', 'episode-1'),
      queryKeys.episodeData('project-1', 'episode-1'),
    ])
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        runningTaskId: 'server-task-1',
        runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
        phase: 'processing',
      },
    })
  })

  it('keeps a successful submit successful when the follow-up refresh rejects', async () => {
    const queryClient = new QueryClient()
    vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValueOnce(new Error('refresh unavailable'))
    const { errors, options } = createHarness(queryClient)
    const variables = input()
    const context = options.onMutate(variables)
    errors['storyboard-1'] = 'previous failure'
    upsertTaskTargetOverlay(queryClient, {
      projectId: 'project-1',
      targetType: 'NovelPromotionStoryboard',
      targetId: 'storyboard-1',
      runningTaskId: 'server-task-1',
      runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      phase: 'processing',
      intent: 'generate',
    })

    await expect(options.onSuccess({ taskId: 'server-task-1' }, variables, context))
      .resolves.toBeUndefined()

    expect(errors['storyboard-1']).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        runningTaskId: 'server-task-1',
        runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
        phase: 'processing',
      },
    })
  })

  it('does not let a stale earlier rejection overwrite or clear a newer generation attempt', () => {
    const queryClient = new QueryClient()
    const { errors, options } = createHarness(queryClient)
    const variables = input()
    const first = options.onMutate(variables)
    const second = options.onMutate(variables)

    options.onError(new Error('stale failure'), variables, first)

    expect(errors['storyboard-1']).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      },
    })

    options.onError(new Error('current failure'), variables, second)
    expect(errors['storyboard-1']).toBe('current failure')
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })

  it('preserves attempt ordering when mutation options are recreated between pending attempts', () => {
    const queryClient = new QueryClient()
    const attemptAccess = createAttemptAccess()
    const errors: Record<string, string> = {}
    const firstOptions = createHarness(queryClient, attemptAccess, errors).options
    const variables = input()
    const first = firstOptions.onMutate(variables)
    const secondOptions = createHarness(queryClient, attemptAccess, errors).options
    const second = secondOptions.onMutate(variables)

    firstOptions.onError(new Error('stale failure from previous options'), variables, first)

    expect(errors['storyboard-1']).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        runningTaskType: TASK_TYPE.STORYBOARD_SHEET_GENERATE,
      },
    })

    secondOptions.onError(new Error('current failure'), variables, second)
    expect(errors['storyboard-1']).toBe('current failure')
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })
})
