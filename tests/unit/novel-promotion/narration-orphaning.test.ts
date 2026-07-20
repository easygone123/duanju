import { describe, expect, it, vi } from 'vitest'
import { detachVoiceLinesBeforePanelRemoval } from '@/lib/novel-promotion/narration/orphaning'

function client(panelIds: string[] = []) {
  return {
    novelPromotionPanel: {
      findMany: vi.fn(async () => panelIds.map((id) => ({ id }))),
    },
    novelPromotionVoiceLine: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  }
}

describe('narration orphaning', () => {
  it('disables and unmatches narration before a storyboard cascade while only unmatching dialogue', async () => {
    const tx = client(['panel-1', 'panel-2'])

    await detachVoiceLinesBeforePanelRemoval({
      tx,
      episodeId: 'episode-1',
      storyboardIds: ['storyboard-1'],
    })

    expect(tx.novelPromotionVoiceLine.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        episodeId: 'episode-1',
        lineType: 'narration',
        OR: expect.arrayContaining([
          { matchedStoryboardId: { in: ['storyboard-1'] } },
          { sourceKey: { in: ['panel-narration:panel-1', 'panel-narration:panel-2'] } },
        ]),
      },
      data: {
        enabled: false,
        matchedPanelId: null,
        matchedStoryboardId: null,
        matchedPanelIndex: null,
      },
    })
    expect(tx.novelPromotionVoiceLine.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        episodeId: 'episode-1',
        lineType: { not: 'narration' },
        OR: expect.arrayContaining([
          { matchedPanelId: { in: ['panel-1', 'panel-2'] } },
          { matchedStoryboardId: { in: ['storyboard-1'] } },
        ]),
      },
      data: {
        matchedPanelId: null,
        matchedStoryboardId: null,
        matchedPanelIndex: null,
      },
    })
  })

  it('uses sourceKey to retain a deleted panel narration for a later same-id sync', async () => {
    const tx = client()

    await detachVoiceLinesBeforePanelRemoval({ tx, panelIds: ['stable-panel'] })

    expect(tx.novelPromotionVoiceLine.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { sourceKey: { in: ['panel-narration:stable-panel'] } },
        ]),
      }),
      data: expect.objectContaining({ enabled: false }),
    }))
  })
})
