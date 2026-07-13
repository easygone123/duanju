import { describe, expect, it, vi } from 'vitest'
import { toPanelUndoApiError, undoSixGridPanelImage } from '@/lib/novel-promotion/six-grid/panel-undo'
import type { PanelUndoClient } from '@/lib/novel-promotion/six-grid/panel-undo'

type PanelFixture = {
  id: string; imageMediaId: string | null; imageUrl: string | null
  previousImageMediaId: string | null; previousImageUrl: string | null
  croppedImageMediaId: string | null; upscaledImageMediaId: string | null
}

const panel: PanelFixture = {
  id: 'panel-1', imageMediaId: 'current-1', imageUrl: '/current.webp',
  previousImageMediaId: 'previous-1', previousImageUrl: '/previous.webp',
  croppedImageMediaId: 'previous-1', upscaledImageMediaId: 'current-1',
}

function db(found: PanelFixture | null = panel, count = 1) {
  const updateMany = vi.fn(async () => ({ count }))
  const findFirst = vi.fn(async () => found)
  return {
    findFirst, updateMany,
    client: {
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        novelPromotionPanel: { findFirst, updateMany },
      })),
    } as unknown as PanelUndoClient,
  }
}

describe('six-grid panel undo CAS', () => {
  it('rejects a panel outside the requested project', async () => {
    const fake = db(null)
    await expect(undoSixGridPanelImage(fake.client, {
      projectId: 'project-a', panelId: 'panel-from-project-b',
      expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    })).rejects.toThrow('SIX_GRID_PANEL_NOT_FOUND')
    expect(fake.updateMany).not.toHaveBeenCalled()
  })

  it('rejects missing previous media and stale client snapshots', async () => {
    await expect(undoSixGridPanelImage(db({ ...panel, previousImageMediaId: null, previousImageUrl: null }).client, {
      projectId: 'project-a', panelId: 'panel-1', expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    })).rejects.toThrow('PREVIOUS_PANEL_IMAGE_REQUIRED')
    await expect(undoSixGridPanelImage(db().client, {
      projectId: 'project-a', panelId: 'panel-1', expectedCurrentMediaId: 'old-current', expectedPreviousMediaId: 'previous-1',
    })).rejects.toThrow('SIX_GRID_PANEL_IMAGE_STALE')
  })

  it('swaps both media directions in one transaction guarded by current and previous ids', async () => {
    const fake = db()
    await undoSixGridPanelImage(fake.client, {
      projectId: 'project-a', panelId: 'panel-1', expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    })
    expect(fake.client.$transaction).toHaveBeenCalledTimes(1)
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { id: 'panel-1', imageMediaId: 'current-1', previousImageMediaId: 'previous-1' },
      data: expect.objectContaining({
        imageMediaId: 'previous-1', imageUrl: '/previous.webp',
        previousImageMediaId: 'current-1', previousImageUrl: '/current.webp',
      }),
    })
  })

  it('reports a CAS collision as stale instead of overwriting a concurrent result', async () => {
    await expect(undoSixGridPanelImage(db(panel, 0).client, {
      projectId: 'project-a', panelId: 'panel-1', expectedCurrentMediaId: 'current-1', expectedPreviousMediaId: 'previous-1',
    })).rejects.toThrow('SIX_GRID_PANEL_IMAGE_STALE')
  })

  it('maps stale undo snapshots to HTTP 409 conflict', () => {
    const error = toPanelUndoApiError(new Error('SIX_GRID_PANEL_IMAGE_STALE'))
    expect(error.status).toBe(409)
    expect(error.details).toMatchObject({ code: 'SIX_GRID_PANEL_IMAGE_STALE' })
  })
})
