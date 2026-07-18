// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStoryboardBatchPanelGeneration } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardBatchPanelGeneration'
import type { StoryboardPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardState'
import type { NovelPromotionStoryboard } from '@/types/project'

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))

function storyboard(id: string, layoutMode: 'individual' | 'four_grid', panelIds: string[]): NovelPromotionStoryboard {
  return {
    id,
    episodeId: 'episode-1',
    clipId: `clip-${id}`,
    layoutMode,
    panelCount: panelIds.length,
    storyboardImageUrl: null,
    storyboardTextJson: null,
    panels: panelIds.map((panelId, panelIndex) => ({
      id: panelId,
      storyboardId: id,
      panelIndex,
      panelNumber: panelIndex + 1,
      imageUrl: null,
    })) as unknown as NovelPromotionStoryboard['panels'],
  }
}

describe('episode panel batch generation with persisted grid rows', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts and submits only persisted individual rows', async () => {
    const individual = storyboard('individual', 'individual', ['individual-panel'])
    const grid = storyboard('grid', 'four_grid', ['grid-panel-1', 'grid-panel-2'])
    const regeneratePanelImage = vi.fn(async () => true)
    const setIsEpisodeBatchSubmitting = vi.fn()

    const { result } = renderHook(() => useStoryboardBatchPanelGeneration({
      sortedStoryboards: [individual, grid],
      submittingPanelImageIds: new Set<string>(),
      getTextPanels: (item) => (item.panels || []) as unknown as StoryboardPanel[],
      regeneratePanelImage,
      setIsEpisodeBatchSubmitting,
    }))

    expect(result.current.pendingPanelCount).toBe(1)
    await act(async () => result.current.handleGenerateAllPanels())
    expect(regeneratePanelImage).toHaveBeenCalledTimes(1)
    expect(regeneratePanelImage).toHaveBeenCalledWith('individual-panel', 1)
  })
})
