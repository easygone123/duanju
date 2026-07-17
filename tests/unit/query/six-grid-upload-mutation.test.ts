import { afterEach, describe, expect, it, vi } from 'vitest'
import { MutationObserver, QueryClient } from '@tanstack/react-query'

import {
  buildSheetUploadRequest,
  createSheetUploadMutationOptions,
  sixGridStoryboardQueryKeys,
  type SheetUploadInput,
} from '@/lib/query/hooks/useSixGridStoryboard'
import { queryKeys } from '@/lib/query/keys'

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

afterEach(() => {
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
  it('adds a process overlay for the exact storyboard target on mutate', async () => {
    const queryClient = new QueryClient()
    const input = uploadInput()
    const options = createUploadOptions(queryClient)

    await options.onMutate(input)

    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toMatchObject({
      'NovelPromotionStoryboard:storyboard-1': {
        targetType: 'NovelPromotionStoryboard',
        targetId: 'storyboard-1',
        intent: 'process',
      },
    })
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

  it('clears the overlay even when the post-upload refresh rejects', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ storyboardId: 'storyboard-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const queryClient = new QueryClient()
    vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValueOnce(new Error('refresh failed'))

    await expect(mutate(queryClient, uploadInput())).rejects.toThrow('refresh failed')

    expect(queryClient.getQueryData(queryKeys.tasks.targetStateOverlay('project-1'))).toEqual({})
  })
})
