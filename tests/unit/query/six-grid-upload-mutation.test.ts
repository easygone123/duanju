// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'

import {
  buildSheetUploadRequest,
  createSheetUploadMutationOptions,
  sixGridStoryboardQueryKeys,
  type SheetUploadInput,
  useSixGridStoryboard,
} from '@/lib/query/hooks/useSixGridStoryboard'
import { queryKeys } from '@/lib/query/keys'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

const uploadInput = (): SheetUploadInput => ({
  file: new File(['sheet'], 'sheet.png', { type: 'image/png' }),
  episodeId: 'episode-1',
  storyboardId: 'storyboard-1',
  expectedSheetArtifactVersion: 7,
})

function createUploadOptions(queryClient: QueryClient) {
  return createSheetUploadMutationOptions(queryClient, 'project-1', 'episode-1')
}

function mutate(queryClient: QueryClient, input: SheetUploadInput) {
  return new MutationObserver(queryClient, createUploadOptions(queryClient)).mutate(input)
}

function createQueryWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(
    QueryClientProvider,
    { client: queryClient },
    children,
  )
}

afterEach(() => {
  cleanup()
  apiFetchMock.mockReset()
})

describe('six-grid external sheet upload request', () => {
  it('builds the upload endpoint and exact multipart fields', () => {
    const input = uploadInput()
    const request = buildSheetUploadRequest('project-1', input)

    expect(request.endpoint).toBe('/api/novel-promotion/project-1/storyboard-sheet/upload')
    expect([...request.body.keys()]).toEqual([
      'file',
      'episodeId',
      'storyboardId',
      'expectedSheetArtifactVersion',
    ])
    expect(request.body.get('file')).toBe(input.file)
    expect(request.body.get('episodeId')).toBe('episode-1')
    expect(request.body.get('storyboardId')).toBe('storyboard-1')
    expect(request.body.get('expectedSheetArtifactVersion')).toBe('7')
  })

  it('submits browser-generated multipart data without a manual Content-Type header', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ storyboardId: 'storyboard-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()

    await createUploadOptions(queryClient).mutationFn(uploadInput())

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [endpoint, init] = apiFetchMock.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe('/api/novel-promotion/project-1/storyboard-sheet/upload')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect(init).not.toHaveProperty('headers')
  })

  it('uses a stable upload error when a non-ok response is not valid JSON', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response('<html>failed</html>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    }))
    const queryClient = new QueryClient()

    await expect(createUploadOptions(queryClient).mutationFn(uploadInput()))
      .rejects.toThrow('Failed to upload six-grid sheet')
  })
})

describe('six-grid external sheet upload lifecycle', () => {
  it('adds a typed upload overlay without activating the storyboard text whitelist', async () => {
    const queryClient = new QueryClient()
    const input = uploadInput()
    const options = createUploadOptions(queryClient)

    await options.onMutate(input)

    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        targetType: 'NovelPromotionStoryboard',
        targetId: 'storyboard-1',
        runningTaskType: 'storyboard_sheet_upload',
        intent: 'process',
      },
    })

    const textState = renderHook(() => useTaskTargetStateMap('project-1', [{
      targetType: 'NovelPromotionStoryboard',
      targetId: 'storyboard-1',
      types: ['regenerate_storyboard_text', 'insert_panel'],
    }], { enabled: false }), { wrapper: createQueryWrapper(queryClient) })
    expect(textState.result.current.getState('NovelPromotionStoryboard', 'storyboard-1')?.phase).toBe('idle')
  })

  it('tags every optimistic grid task so sheet generation cannot activate text state', async () => {
    apiFetchMock.mockImplementation(async () => new Response(JSON.stringify({ taskId: 'task-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    const wrapper = createQueryWrapper(queryClient)
    const grid = renderHook(() => useSixGridStoryboard('project-1', 'episode-1'), { wrapper })
    const overlays = () => queryClient.getQueryData<Record<string, { runningTaskType: string }>>(
      queryKeys.tasks.targetStateOverlay('project-1'),
    )

    await act(async () => {
      await grid.result.current.sheet.mutateAsync({
        operation: 'generate', episodeId: 'episode-1', storyboardId: 'storyboard-1',
      })
    })
    expect(overlays()?.['NovelPromotionStoryboard:storyboard-1']?.runningTaskType)
      .toBe('storyboard_sheet_generate')

    const textState = renderHook(() => useTaskTargetStateMap('project-1', [{
      targetType: 'NovelPromotionStoryboard',
      targetId: 'storyboard-1',
      types: ['regenerate_storyboard_text', 'insert_panel'],
    }], { enabled: false }), { wrapper })
    expect(textState.result.current.getState('NovelPromotionStoryboard', 'storyboard-1')?.phase).toBe('idle')

    await act(async () => {
      await grid.result.current.sheet.mutateAsync({
        operation: 'upscale', episodeId: 'episode-1', storyboardId: 'storyboard-1',
      })
    })
    expect(overlays()?.['NovelPromotionStoryboard:storyboard-1']?.runningTaskType)
      .toBe('storyboard_sheet_upscale')

    await act(async () => {
      await grid.result.current.crop.mutateAsync({
        episodeId: 'episode-1', storyboardId: 'storyboard-1', cropRects: [],
      })
    })
    expect(overlays()?.['NovelPromotionStoryboard:storyboard-1']?.runningTaskType)
      .toBe('storyboard_sheet_crop')

    await act(async () => {
      await grid.result.current.panelUpscale.mutateAsync({
        episodeId: 'episode-1', storyboardId: 'storyboard-1', panelId: 'panel-1',
        workflowId: 'workflow-1', workflowVersionId: 'version-1',
      })
    })
    expect(overlays()?.['NovelPromotionPanel:panel-1']?.runningTaskType)
      .toBe('storyboard_panel_upscale')
  })

  it('invalidates the group and active episode stage, then clears the overlay after success', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ storyboardId: 'storyboard-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()

    await mutate(queryClient, uploadInput())

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: sixGridStoryboardQueryKeys.group('project-1', 'episode-1', 'storyboard-1'),
      exact: true,
    })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.episodeStages('project-1', 'episode-1'),
    })
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })

  it('refetches active group and episode-stage queries through a real QueryClient', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ storyboardId: 'storyboard-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    const groupFetch = vi.fn(async () => ({ sheetArtifactVersion: groupFetch.mock.calls.length }))
    const stageFetch = vi.fn(async () => ({ sheetArtifactVersion: stageFetch.mock.calls.length }))
    const groupObserver = new QueryObserver(queryClient, {
      queryKey: sixGridStoryboardQueryKeys.group('project-1', 'episode-1', 'storyboard-1'),
      queryFn: groupFetch,
    })
    const stageObserver = new QueryObserver(queryClient, {
      queryKey: queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'),
      queryFn: stageFetch,
    })
    const unsubscribeGroup = groupObserver.subscribe(() => undefined)
    const unsubscribeStage = stageObserver.subscribe(() => undefined)
    await Promise.all([groupObserver.refetch(), stageObserver.refetch()])
    const groupCallsBeforeUpload = groupFetch.mock.calls.length
    const stageCallsBeforeUpload = stageFetch.mock.calls.length

    try {
      await mutate(queryClient, uploadInput())

      expect(groupFetch.mock.calls.length).toBeGreaterThan(groupCallsBeforeUpload)
      expect(stageFetch.mock.calls.length).toBeGreaterThan(stageCallsBeforeUpload)
      expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
    } finally {
      unsubscribeGroup()
      unsubscribeStage()
    }
  })

  it('clears the overlay without invalidating or changing the current sheet after failure', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Version conflict' } }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    const stageKey = queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')
    const current = {
      stage: 'storyboard',
      episode: { storyboards: [{ id: 'storyboard-1', sheetImageUrl: '/current-sheet.png', sheetArtifactVersion: 7 }] },
    }
    queryClient.setQueryData(stageKey, current)
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await expect(mutate(queryClient, uploadInput())).rejects.toThrow('Version conflict')

    expect(invalidate).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(stageKey)).toBe(current)
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })

  it('preserves upload success and clears the overlay when the post-upload refresh rejects', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ storyboardId: 'storyboard-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    let rejectRefresh!: (error: Error) => void
    const refresh = new Promise<void>((_resolve, reject) => {
      rejectRefresh = reject
    })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      .mockReturnValueOnce(refresh)
      .mockResolvedValue(undefined)
    const observer = new MutationObserver(queryClient, createUploadOptions(queryClient))
    const request = observer.mutate(uploadInput())

    await vi.waitFor(() => expect(invalidate).toHaveBeenCalled())
    expect(observer.getCurrentResult().isPending).toBe(true)
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': { intent: 'process' },
    })
    rejectRefresh(new Error('refresh failed'))

    await expect(request).resolves.toEqual({ storyboardId: 'storyboard-1' })

    expect(observer.getCurrentResult().isSuccess).toBe(true)
    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })
})
