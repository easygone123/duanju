// @vitest-environment jsdom

import React from 'react'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query/keys'
import {
  episodeStageQueryOptions,
  useEpisodeStageData,
  type ConfigEpisodeStagePayload,
  type EpisodeStagePayload,
} from '@/lib/query/hooks/useEpisodeStageData'
import { useWorkspaceEpisodeStageData } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceEpisodeStageData'
import { invalidateEpisodeStageQueries } from '@/lib/query/episode-stage-cache'
import { useStoryboardState } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardState'
import { usePanelEpisodeCachePatch } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/usePanelEpisodeCachePatch'
import type { NovelPromotionStoryboard } from '@/types/project'
import {
  useUpdateProjectPanelActingNotes,
  useUpdateProjectPhotographyPlan,
} from '@/lib/query/mutations/storyboard-prompt-mutations'
import {
  useCreateProjectVoiceLine,
  useDeleteProjectVoiceLine,
  useUpdateProjectVoiceLine,
} from '@/lib/query/mutations/useVoiceMutations'
import { useUpdateProjectEpisodeField } from '@/lib/query/mutations/useEpisodeMutations'

const apiFetchMock = vi.hoisted(() => vi.fn())
const workspaceContext = vi.hoisted(() => ({ projectId: 'project/one', episodeId: 'episode two' }))

vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceProvider', () => ({
  useWorkspaceProvider: () => workspaceContext,
}))

function response(stage: string, episode: Record<string, unknown>) {
  return new Response(JSON.stringify({ stage, episode }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(cleanup)

describe('episode stage query', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('isolates stages under a stable episode prefix without a cursor dimension', () => {
    expect(queryKeys.episodeStages('project-1')).toEqual(['episode-stages', 'project-1'])
    expect(queryKeys.episodeStages('project-1', 'episode-1')).toEqual([
      'episode-stages', 'project-1', 'episode-1',
    ])
    expect(queryKeys.episodeStage('project-1', 'episode-1', 'script')).toEqual([
      'episode-stages', 'project-1', 'episode-1', 'script',
    ])
    expect((queryKeys.episodeStage as (...args: string[]) => readonly string[])(
      'project-1', 'episode-1', 'script', 'ignored-cursor',
    )).toEqual(['episode-stages', 'project-1', 'episode-1', 'script'])
    expect(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')).not.toEqual(
      queryKeys.episodeStage('project-1', 'episode-1', 'videos'),
    )
  })

  it('never appends an unsupported cursor query to the full stage endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce(response('script', { id: 'episode-1', name: 'Episode', clips: [] }))
    const queryClient = client()
    const options = (episodeStageQueryOptions as (...args: string[]) => ReturnType<typeof episodeStageQueryOptions>)(
      'project-1', 'episode-1', 'script', 'ignored-cursor',
    )

    await queryClient.fetchQuery(options)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/novel-promotion/project-1/episodes/episode-1/stage/script',
    )
  })

  it('invalidates all stage projections and the compatibility full episode cache together', async () => {
    const queryClient = client()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await invalidateEpisodeStageQueries(queryClient, 'project-1', 'episode-1')

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeStages('project-1', 'episode-1'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeData('project-1', 'episode-1'),
    })
  })

  it('invalidates project-wide stage and legacy episode prefixes when the episode id is unknown', async () => {
    const queryClient = client()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await invalidateEpisodeStageQueries(queryClient, 'project-1')

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeStages('project-1'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['episode-data', 'project-1'],
    })
  })

  it('encodes route ids, uses the established stale time, and returns a discriminated payload', async () => {
    apiFetchMock.mockResolvedValueOnce(response('config', {
      id: 'episode two', name: 'Episode', novelText: 'story',
      readiness: { hasStory: true, hasScript: false, hasStoryboard: false, hasVideo: false, hasVoice: false },
    }))
    const queryClient = client()
    const options = episodeStageQueryOptions('project/one', 'episode two', 'config')
    const payload = await queryClient.fetchQuery(options)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/novel-promotion/project%2Fone/episodes/episode%20two/stage/config',
    )
    expect(options.staleTime).toBe(5000)
    expect(payload.stage).toBe('config')
    if (payload.stage === 'config') {
      expectTypeOf(payload).toEqualTypeOf<ConfigEpisodeStagePayload>()
      expect(payload.episode.novelText).toBe('story')
    }
    expectTypeOf(payload).toMatchTypeOf<EpisodeStagePayload>()
  })

  it('deduplicates consumers with the same stage key', async () => {
    apiFetchMock.mockResolvedValue(response('script', { id: 'episode-1', name: 'Episode', clips: [] }))
    const queryClient = client()
    const options = episodeStageQueryOptions('project-1', 'episode-1', 'script')

    const [first, second] = await Promise.all([
      queryClient.fetchQuery(options),
      queryClient.fetchQuery(options),
    ])

    expect(first).toEqual(second)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched response discriminant before the compatibility facade can cast it', async () => {
    apiFetchMock.mockResolvedValueOnce(response('videos', {
      id: 'episode-1', name: 'Episode', clips: [], storyboards: [],
    }))
    const queryClient = client()

    await expect(queryClient.fetchQuery(
      episodeStageQueryOptions('project-1', 'episode-1', 'storyboard'),
    )).rejects.toThrow('Episode stage response mismatch: expected storyboard, received videos')
  })

  it('disables the hook when either route id is missing', () => {
    const queryClient = client()
    const { result } = renderHook(
      () => useEpisodeStageData(null, 'episode-1', 'config'),
      { wrapper: wrapper(queryClient) },
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(episodeStageQueryOptions('', 'episode-1', 'config').enabled).toBe(false)
    expect(episodeStageQueryOptions('project-1', '', 'config').enabled).toBe(false)
  })

  it('keeps the workspace facade canonical and preserves the legacy full episode query API', async () => {
    apiFetchMock.mockResolvedValueOnce(response('script', {
      id: 'episode two', name: 'Episode', clips: [{ id: 'clip-1', summary: 'one' }],
    }))
    const queryClient = client()
    const { result } = renderHook(
      () => useWorkspaceEpisodeStageData('script'),
      { wrapper: wrapper(queryClient) },
    )

    await waitFor(() => expect(result.current.clips).toHaveLength(1))
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/novel-promotion/project%2Fone/episodes/episode%20two/stage/script',
    )
    const legacySource = readFileSync('src/lib/query/hooks/useProjectData.ts', 'utf8')
    expect(legacySource).toContain('export function useEpisodeData')
    expect(legacySource).toContain('/episodes/${episodeId}`')
  })

  it('serializes rapid novelText writes while keeping the visible config cache at the latest value', async () => {
    const firstResponse = deferred<Response>()
    const secondResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let firstWrite!: Promise<unknown>
    let secondWrite!: Promise<unknown>
    act(() => {
      firstWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      })
      secondWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      })
    })

    await waitFor(() => {
      const cached = queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)
      expect(cached?.episode.novelText).toBe('ab')
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
    })

    firstResponse.resolve(response('ignored', { ok: true }))
    await act(async () => { await firstWrite })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('ab')

    secondResponse.resolve(response('ignored', { ok: true }))
    await act(async () => { await secondWrite })

    expect(apiFetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).novelText)).toEqual(['a', 'ab'])
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('ab')
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: queryKeys.episodeStages('project-1', 'episode-1'),
    })
  })

  it('does not let an older failed novelText write roll back a newer optimistic value', async () => {
    const firstResponse = deferred<Response>()
    const secondResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let failedWrite!: Promise<unknown>
    let latestWrite!: Promise<unknown>
    act(() => {
      failedWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      }).catch((error) => error)
      latestWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      })
    })

    await waitFor(() => expect(
      queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText,
    ).toBe('ab'))
    firstResponse.resolve(new Response(JSON.stringify({ error: 'write failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    await act(async () => { await failedWrite })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('ab')

    secondResponse.resolve(response('ignored', { ok: true }))
    await act(async () => { await latestWrite })
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('ab')
  })

  it('restores the confirmed server value after two consecutive novelText writes fail', async () => {
    const firstResponse = deferred<Response>()
    const secondResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let firstWrite!: Promise<unknown>
    let secondWrite!: Promise<unknown>
    act(() => {
      firstWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      }).catch((error) => error)
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      secondWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      }).catch((error) => error)
    })

    firstResponse.resolve(new Response(JSON.stringify({ error: 'first failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    await act(async () => { await firstWrite })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    secondResponse.resolve(new Response(JSON.stringify({ error: 'second failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    await act(async () => { await secondWrite })

    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('')
  })

  it('coalesces fast novelText drafts to one in-flight request plus the newest unsent value', async () => {
    const firstResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValue(response('ignored', { ok: true }))
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    const writes: Promise<unknown>[] = []
    act(() => {
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      }))
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      }))
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abc',
      }))
    })

    await waitFor(() => expect(
      queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText,
    ).toBe('abc'))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    firstResponse.resolve(response('ignored', { ok: true }))
    await act(async () => { await Promise.all(writes) })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).novelText)).toEqual(['a', 'abc'])
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('abc')
  })

  it('keeps a coalesced novelText caller pending and resolves it with the dispatched tail result', async () => {
    const firstResponse = deferred<Response>()
    const tailResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => tailResponse.promise)
    const queryClient = client()
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'config'), {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let firstWrite!: Promise<unknown>
    let middleWrite!: Promise<unknown>
    let tailWrite!: Promise<unknown>
    act(() => {
      firstWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      })
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      middleWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      })
      tailWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abc',
      })
    })
    let middleState = 'pending'
    void middleWrite.then(() => { middleState = 'fulfilled' }, () => { middleState = 'rejected' })

    firstResponse.resolve(response('ignored', { saved: 'a' }))
    const firstResult = await firstWrite
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    expect(middleState).toBe('pending')

    tailResponse.resolve(response('ignored', { saved: 'abc' }))
    const [middleResult, tailResult] = await Promise.all([middleWrite, tailWrite])

    expect(firstResult).toEqual({ stage: 'ignored', episode: { saved: 'a' } })
    expect(middleResult).toBe(tailResult)
    expect(tailResult).toEqual({ stage: 'ignored', episode: { saved: 'abc' } })
  })

  it('rejects every coalesced novelText caller with the dispatched tail failure', async () => {
    const firstResponse = deferred<Response>()
    const tailResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => tailResponse.promise)
    const queryClient = client()
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'config'), {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let firstWrite!: Promise<unknown>
    let middleWrite!: Promise<unknown>
    let tailWrite!: Promise<unknown>
    act(() => {
      firstWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      })
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      middleWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      })
      tailWrite = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abc',
      })
    })
    const middleOutcome = middleWrite.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    const tailOutcome = tailWrite.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )

    firstResponse.resolve(response('ignored', { saved: 'a' }))
    await expect(firstWrite).resolves.toEqual({ stage: 'ignored', episode: { saved: 'a' } })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    tailResponse.resolve(new Response(JSON.stringify({ error: 'tail failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    const [middle, tail] = await Promise.all([middleOutcome, tailOutcome])

    expect(middle.status).toBe('rejected')
    expect(tail.status).toBe('rejected')
    if (middle.status === 'rejected' && tail.status === 'rejected') {
      expect(middle.error).toBe(tail.error)
      expect(middle.error).toMatchObject({ message: 'tail failed', status: 500 })
    }
  })

  it('dispatches the newest unsent novelText draft after the mutation consumer unmounts', async () => {
    const firstResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValue(response('ignored', { ok: true }))
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    const writes: Promise<unknown>[] = []
    act(() => {
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      }))
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'ab',
      }))
      writes.push(mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abc',
      }))
    })

    mutation.unmount()
    firstResponse.resolve(response('ignored', { ok: true }))
    await Promise.all(writes)

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).novelText)).toEqual(['a', 'abc'])
  })

  it('shares the confirmed novelText transaction across an unmount and remount', async () => {
    const firstResponse = deferred<Response>()
    const tailResponse = deferred<Response>()
    apiFetchMock
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => tailResponse.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'separate new write failed' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }))
    const queryClient = client()
    const episodeKey = queryKeys.episodeData('project-1', 'episode-1')
    const projectKey = queryKeys.projectData('project-1')
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(episodeKey, {
      id: 'episode-1', name: 'Episode', novelText: '',
    })
    queryClient.setQueryData(projectKey, {
      novelPromotionData: {
        episodes: [{ id: 'episode-1', name: 'Episode', novelText: '' }],
      },
    })
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: '' },
    })
    const oldConsumer = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let firstWrite!: Promise<unknown>
    let oldTailWrite!: Promise<unknown>
    act(() => {
      firstWrite = oldConsumer.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'a',
      })
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      oldTailWrite = oldConsumer.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abc',
      })
    })
    await waitFor(() => expect(
      queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText,
    ).toBe('abc'))
    oldConsumer.unmount()

    const newConsumer = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )
    let newTailWrite!: Promise<unknown>
    act(() => {
      newTailWrite = newConsumer.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'abcd',
      })
    })
    const firstOutcome = firstWrite.catch((error: unknown) => error)
    const oldTailOutcome = oldTailWrite.catch((error: unknown) => error)
    const newTailOutcome = newTailWrite.catch((error: unknown) => error)
    await waitFor(() => expect(
      queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText,
    ).toBe('abcd'))

    firstResponse.resolve(new Response(JSON.stringify({ error: 'first failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    await firstOutcome
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    tailResponse.resolve(new Response(JSON.stringify({ error: 'shared tail failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    const [oldTailError, newTailError] = await Promise.all([oldTailOutcome, newTailOutcome])

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(apiFetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).novelText)).toEqual(['a', 'abcd'])
    expect(oldTailError).toBe(newTailError)
    expect(oldTailError).toMatchObject({ message: 'shared tail failed', status: 500 })
    expect(queryClient.getQueryData<{ novelText: string }>(episodeKey)?.novelText).toBe('')
    expect(queryClient.getQueryData<{
      novelPromotionData: { episodes: Array<{ id: string; novelText: string }> }
    }>(projectKey)?.novelPromotionData.episodes[0]?.novelText).toBe('')
    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('')
  })

  it('rolls back a failed latest novelText write to its config-stage snapshot', async () => {
    const failedResponse = deferred<Response>()
    apiFetchMock.mockImplementationOnce(() => failedResponse.promise)
    const queryClient = client()
    const configKey = queryKeys.episodeStage('project-1', 'episode-1', 'config')
    queryClient.setQueryData(configKey, {
      stage: 'config',
      episode: { id: 'episode-1', name: 'Episode', novelText: 'server' },
    })
    const mutation = renderHook(
      () => useUpdateProjectEpisodeField('project-1'),
      { wrapper: wrapper(queryClient) },
    )

    let write!: Promise<unknown>
    act(() => {
      write = mutation.result.current.mutateAsync({
        episodeId: 'episode-1', key: 'novelText', value: 'draft',
      })
    })

    await waitFor(() => expect(
      queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText,
    ).toBe('draft'))
    failedResponse.resolve(new Response(JSON.stringify({ error: 'write failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }))
    await act(async () => { await expect(write).rejects.toThrow('write failed') })

    expect(queryClient.getQueryData<{ episode: { novelText: string } }>(configKey)?.episode.novelText).toBe('server')
  })

  it('removes the old full episode query from every workspace cold-entry consumer', () => {
    const coldEntryFiles = [
      'src/app/[locale]/workspace/[projectId]/page.tsx',
      'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useNovelPromotionWorkspaceController.ts',
      'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/hooks/useWorkspaceEpisodeStageData.ts',
      'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/AssetsStage.tsx',
      'src/lib/novel-promotion/stages/voice-stage-runtime-core.tsx',
    ]

    for (const path of coldEntryFiles) {
      expect(readFileSync(path, 'utf8'), path).not.toContain('useEpisodeData')
    }
  })

  it('invalidates the renamed episode id instead of the currently selected episode id', () => {
    const pageSource = readFileSync('src/app/[locale]/workspace/[projectId]/page.tsx', 'utf8')
    const renameHandler = pageSource.slice(
      pageSource.indexOf('const handleRenameEpisode'),
      pageSource.indexOf('// 删除剧集'),
    )

    expect(renameHandler).toContain('invalidateEpisodeStageQueries(queryClient, projectId, episodeId)')
    expect(renameHandler).not.toContain('episodeData(projectId, selectedEpisodeId)')
    expect(renameHandler).not.toContain('episodeStages(projectId, selectedEpisodeId)')
  })

  it('invalidates both cache families after late storyboard and voice writes', async () => {
    apiFetchMock.mockResolvedValue(new Response(JSON.stringify({ voiceLine: { id: 'line-1' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = client()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const mutations = renderHook(() => ({
      photography: useUpdateProjectPhotographyPlan('project-1'),
      acting: useUpdateProjectPanelActingNotes('project-1'),
      createVoice: useCreateProjectVoiceLine('project-1'),
      updateVoice: useUpdateProjectVoiceLine('project-1'),
      deleteVoice: useDeleteProjectVoiceLine('project-1'),
    }), { wrapper: wrapper(queryClient) })

    await act(async () => {
      await mutations.result.current.photography.mutateAsync({ storyboardId: 'sb-1', photographyPlan: '{}' })
      await mutations.result.current.acting.mutateAsync({ storyboardId: 'sb-1', panelIndex: 0, actingNotes: '{}' })
      await mutations.result.current.createVoice.mutateAsync({
        episodeId: 'episode-1', content: 'line', speaker: 'Alice',
      })
      await mutations.result.current.updateVoice.mutateAsync({ lineId: 'line-1', content: 'updated' })
      await mutations.result.current.deleteVoice.mutateAsync({ lineId: 'line-1' })
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.episodeStages('project-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.episodeData('project-1') })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeStages('project-1', 'episode-1'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeData('project-1', 'episode-1'),
    })
  })

  it('invalidates deleted episode stage and legacy caches through the shared helper', () => {
    const pageSource = readFileSync('src/app/[locale]/workspace/[projectId]/page.tsx', 'utf8')
    const deleteHandler = pageSource.slice(
      pageSource.indexOf('const handleDeleteEpisode'),
      pageSource.indexOf('// 选择剧集'),
    )

    expect(deleteHandler).toContain('invalidateEpisodeStageQueries(queryClient, projectId, episodeId)')
    expect(deleteHandler).not.toContain('queryKeys.episodeStages(projectId, episodeId)')
  })

  it('wires stage-prefix invalidation into refresh, SSE, and episode/clip/storyboard/panel mutations', () => {
    const invalidationConsumers = [
      'src/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceProvider.tsx',
      'src/lib/query/hooks/useSSE.ts',
      'src/lib/query/mutations/useEpisodeMutations.ts',
      'src/lib/query/hooks/useStoryboards.ts',
      'src/lib/query/mutations/storyboard-panel-mutations.ts',
      'src/lib/query/mutations/useVideoMutations.ts',
    ]

    for (const path of invalidationConsumers) {
      expect(readFileSync(path, 'utf8'), path).toMatch(
        /episodeStages|episodeStage|invalidateEpisodeStageQueries|applyWorkspaceTaskCompletion/,
      )
    }
  })

  it('patches the canonical storyboard-stage cache used by the visible cold-path stage', () => {
    const queryClient = client()
    const storyboard = {
      id: 'storyboard-1', episodeId: 'episode-1', clipId: 'clip-1', panelCount: 1,
      storyboardTextJson: null, storyboardImageUrl: null,
      panels: [{ id: 'panel-1', storyboardId: 'storyboard-1', panelIndex: 0, imageUrl: 'before.jpg' }],
    } as unknown as NovelPromotionStoryboard
    const key = queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')
    queryClient.setQueryData(key, {
      stage: 'storyboard',
      episode: { id: 'episode-1', name: 'Episode', episodeNumber: 1, clips: [], storyboards: [storyboard] },
    })

    const state = renderHook(() => useStoryboardState({
      projectId: 'project-1', episodeId: 'episode-1', initialStoryboards: [storyboard], clips: [],
    }), { wrapper: wrapper(queryClient) })
    act(() => state.result.current.setLocalStoryboards((previous) => previous.map((item) => ({
      ...item, panelCount: 2,
    }))))

    const patch = renderHook(() => usePanelEpisodeCachePatch({
      projectId: 'project-1', episodeId: 'episode-1',
    }), { wrapper: wrapper(queryClient) })
    act(() => patch.result.current('panel-1', { imageUrl: 'after.jpg' }))

    const cached = queryClient.getQueryData(key) as {
      episode: { storyboards: NovelPromotionStoryboard[] }
    }
    expect(cached.episode.storyboards[0].panelCount).toBe(2)
    expect(cached.episode.storyboards[0].panels?.[0].imageUrl).toBe('after.jpg')
  })
})
