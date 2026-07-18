import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildMockRequest } from '../../../helpers/request'

const txMock = vi.hoisted(() => ({
  voiceLineUpdateMany: vi.fn(async () => ({ count: 1 })),
  panelDeleteMany: vi.fn(async () => ({ count: 4 })),
  storyboardDelete: vi.fn(async () => ({ id: 'storyboard-selected' })),
  storyboardCount: vi.fn(async () => 1),
  clipDelete: vi.fn(async () => ({ id: 'clip-shared' })),
}))

const prismaMock = vi.hoisted(() => ({
  novelPromotionStoryboard: {
    findFirst: vi.fn(async () => ({
      id: 'storyboard-selected',
      episodeId: 'episode-1',
      clipId: 'clip-shared',
      panels: [
        { id: 'panel-1' },
        { id: 'panel-2' },
        { id: 'panel-3' },
        { id: 'panel-4' },
      ],
      clip: { id: 'clip-shared' },
    })),
  },
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => await callback({
    novelPromotionVoiceLine: { updateMany: txMock.voiceLineUpdateMany },
    novelPromotionPanel: { deleteMany: txMock.panelDeleteMany },
    novelPromotionStoryboard: {
      delete: txMock.storyboardDelete,
      count: txMock.storyboardCount,
    },
    novelPromotionClip: { delete: txMock.clipDelete },
  })),
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
    project: { id: 'project-1', userId: 'user-1' },
  })),
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

async function deleteStoryboardGroup() {
  const { DELETE } = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
  return await DELETE(buildMockRequest({
    path: '/api/novel-promotion/project-1/storyboard-group?storyboardId=storyboard-selected',
    method: 'DELETE',
  }), { params: Promise.resolve({ projectId: 'project-1' }) })
}

describe('storyboard-group DELETE shared clip safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    txMock.storyboardCount.mockResolvedValue(1)
  })

  it('clears voice matches before deleting the selected storyboard', async () => {
    const response = await deleteStoryboardGroup()

    expect(response.status).toBe(200)
    expect(txMock.voiceLineUpdateMany).toHaveBeenCalledWith({
      where: {
        episodeId: 'episode-1',
        matchedStoryboardId: 'storyboard-selected',
      },
      data: {
        matchedPanelId: null,
        matchedStoryboardId: null,
        matchedPanelIndex: null,
      },
    })
    expect(txMock.voiceLineUpdateMany.mock.invocationCallOrder[0])
      .toBeLessThan(txMock.panelDeleteMany.mock.invocationCallOrder[0]!)
    expect(txMock.voiceLineUpdateMany.mock.invocationCallOrder[0])
      .toBeLessThan(txMock.storyboardDelete.mock.invocationCallOrder[0]!)
  })

  it('preserves a clip while a sibling storyboard still references it', async () => {
    const response = await deleteStoryboardGroup()

    expect(response.status).toBe(200)
    expect(txMock.storyboardCount).toHaveBeenCalledWith({
      where: { clipId: 'clip-shared' },
    })
    expect(txMock.clipDelete).not.toHaveBeenCalled()
  })

  it('deletes the clip when the selected storyboard was its final reference', async () => {
    txMock.storyboardCount.mockResolvedValue(0)

    const response = await deleteStoryboardGroup()

    expect(response.status).toBe(200)
    expect(txMock.clipDelete).toHaveBeenCalledWith({
      where: { id: 'clip-shared' },
    })
  })
})
