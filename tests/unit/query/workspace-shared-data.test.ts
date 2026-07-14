// @vitest-environment jsdom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  useUserModels: vi.fn(),
  useProjectAssets: vi.fn(),
  useSSE: vi.fn(),
}))

vi.mock('@/lib/query/hooks/useUserModels', () => ({
  useUserModels: hooks.useUserModels,
  selectImageModelOptions: (data: { image?: unknown[] } | undefined) => data?.image ?? [],
}))
vi.mock('@/lib/query/hooks/useProjectAssets', () => ({ useProjectAssets: hooks.useProjectAssets }))
vi.mock('@/lib/query/hooks/useSSE', () => ({ useSSE: hooks.useSSE }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    refetchQueries: vi.fn(async () => undefined),
    invalidateQueries: vi.fn(async () => undefined),
    setQueriesData: vi.fn(),
    setQueryData: vi.fn(),
  }),
}))

afterEach(cleanup)

describe('workspace shared data', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hooks.useUserModels.mockReturnValue({
      data: { image: [{ value: 'image-1' }], video: [{ value: 'video-1' }], upscale: [] },
      isFetched: true,
      error: null,
    })
    hooks.useProjectAssets.mockReturnValue({
      data: { characters: [{ id: 'character-1' }], locations: [], props: [] },
      isFetched: true,
      error: null,
    })
  })

  it('serves 100 consumers through one model observer and one asset observer', async () => {
    const { WorkspaceProvider } = await import(
      '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceProvider'
    )
    const { useWorkspaceData } = await import(
      '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceDataProvider'
    )

    function Consumer() {
      const snapshot = useWorkspaceData()
      return React.createElement('span', null, `${snapshot.imageModelOptions.length}:${snapshot.projectAssets.characters.length}`)
    }

    const consumers = React.createElement(React.Fragment, null,
        ...Array.from({ length: 100 }, (_, index) => React.createElement(Consumer, { key: index })),
      )
    render(React.createElement(
      WorkspaceProvider,
      { projectId: 'project-1', episodeId: 'episode-1' },
      consumers,
    ))

    expect(hooks.useUserModels).toHaveBeenCalledTimes(1)
    expect(hooks.useProjectAssets).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('span')).toHaveLength(100)
    expect(document.querySelector('span')?.textContent).toBe('1:1')
  })
})
