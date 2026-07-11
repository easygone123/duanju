import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query/keys'
import {
  selectImageModelOptions,
  invalidateUserModels,
  userModelsQueryOptions,
} from '@/lib/query/hooks/useUserModels'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

function response(image: Array<Record<string, unknown>>, video: Array<Record<string, unknown>> = []) {
  return new Response(JSON.stringify({ llm: [], image, video, audio: [], lipsync: [] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

describe('user model query cache', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('returns full image options and exposes a newly published workflow after invalidation', async () => {
    const queryClient = client()
    const cloud = {
      value: 'cloud::image', label: 'Cloud Image', provider: 'cloud', providerName: 'Cloud Inc',
      capabilities: { image: { resolutionOptions: ['1024x1024'] } },
    }
    apiFetchMock.mockResolvedValueOnce(response([cloud]))
    const initial = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    expect(selectImageModelOptions(initial)).toEqual([cloud])

    const workflow = { value: 'comfyui::wf-new', label: 'New Workflow', provider: 'comfyui', providerName: 'ComfyUI' }
    apiFetchMock.mockResolvedValueOnce(response([cloud, workflow]))
    await invalidateUserModels(queryClient)
    const refreshed = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    expect(selectImageModelOptions(refreshed)).toEqual([cloud, workflow])
  })

  it('does not share cached user models when the authenticated user changes', async () => {
    const queryClient = client()
    apiFetchMock
      .mockResolvedValueOnce(response([{ value: 'comfyui::a', label: 'A', provider: 'comfyui' }]))
      .mockResolvedValueOnce(response([{ value: 'comfyui::b', label: 'B', provider: 'comfyui' }]))

    const userA = await queryClient.fetchQuery(userModelsQueryOptions('user-a'))
    const userB = await queryClient.fetchQuery(userModelsQueryOptions('user-b'))
    expect(userA.image[0].value).toBe('comfyui::a')
    expect(userB.image[0].value).toBe('comfyui::b')
    expect(queryClient.getQueryData(queryKeys.userModels.scope('user-a'))).toEqual(userA)
    expect(queryClient.getQueryData(queryKeys.userModels.scope('user-b'))).toEqual(userB)
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
  })
})
