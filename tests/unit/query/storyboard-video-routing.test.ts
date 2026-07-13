import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  json: async () => ({ tasks: [], total: 0 }),
})))
const checkApiResponseMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(async () => undefined),
  })),
  useMutation: vi.fn((configuration: unknown) => configuration),
}))
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/lib/error-handler', () => ({ checkApiResponse: checkApiResponseMock }))

import { useBatchGenerateVideos } from '@/lib/query/hooks/useStoryboards'

describe('batch video request routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks the batch request for per-panel project routing instead of treating videoModel as explicit', async () => {
    const mutation = useBatchGenerateVideos('project-1', 'episode-1') as unknown as {
      mutationFn: (params: { videoModel: string; generationOptions?: Record<string, string | number | boolean> }) => Promise<unknown>
    }

    await mutation.mutationFn({ videoModel: 'cloud::normal', generationOptions: { resolution: '720p' } })

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/novel-promotion/project-1/generate-video',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          all: true,
          episodeId: 'episode-1',
          videoModel: 'cloud::normal',
          useProjectRouting: true,
          generationOptions: { resolution: '720p' },
        }),
      }),
    )
  })
})
