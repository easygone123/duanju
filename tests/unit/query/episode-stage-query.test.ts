// @vitest-environment jsdom

import React from 'react'
import { readFileSync } from 'node:fs'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
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

afterEach(cleanup)

describe('episode stage query', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('isolates stages and cursors under a stable episode prefix', () => {
    expect(queryKeys.episodeStages('project-1')).toEqual(['episode-stages', 'project-1'])
    expect(queryKeys.episodeStages('project-1', 'episode-1')).toEqual([
      'episode-stages', 'project-1', 'episode-1',
    ])
    expect(queryKeys.episodeStage('project-1', 'episode-1', 'script')).toEqual([
      'episode-stages', 'project-1', 'episode-1', 'script',
    ])
    expect(queryKeys.episodeStage('project-1', 'episode-1', 'script', 'cursor-2')).toEqual([
      'episode-stages', 'project-1', 'episode-1', 'script', 'cursor-2',
    ])
    expect(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard')).not.toEqual(
      queryKeys.episodeStage('project-1', 'episode-1', 'videos'),
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
      expect(readFileSync(path, 'utf8'), path).toMatch(/episodeStages|invalidateEpisodeStageQueries/)
    }
  })
})
