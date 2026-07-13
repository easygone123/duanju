import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  novelPromotionStoryboard: {
    findMany: vi.fn(),
  },
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: async (projectId: string) => ({
    session: { user: { id: 'user-1' } },
    project: { id: projectId, userId: 'user-1' },
  }),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { POST } from '@/app/api/novel-promotion/[projectId]/panel-link/route'

function panel(id: string, storyboardId: string, panelIndex: number, gridCellIndex = panelIndex) {
  return {
    id,
    storyboardId,
    panelIndex,
    gridCellIndex,
    firstFrameSourceMeta: null,
    lastFrameSourceMeta: null,
    storyboard: { episodeId: 'episode-1' },
  }
}

function storyboard(
  id: string,
  groupSequence: number,
  sceneKey: string,
  panelIds: string[],
) {
  return {
    id,
    layoutMode: 'six_grid',
    groupSequence,
    continuityAnchor: JSON.stringify({ sceneKey }),
    panels: panelIds.map((panelId, index) => panel(panelId, id, index)),
  }
}

async function post(body: Record<string, unknown>, projectId = 'project-1') {
  return POST(buildMockRequest({
    path: `/api/novel-promotion/${projectId}/panel-link`,
    method: 'POST',
    body,
  }), { params: Promise.resolve({ projectId }) })
}

describe('panel-link route contract', () => {
  const group1 = storyboard(
    'storyboard-1', 1, 'office',
    ['panel-0', 'panel-1', 'panel-2', 'panel-3', 'panel-4', 'panel-5'],
  )
  const group2 = storyboard(
    'storyboard-2', 2, 'office',
    ['panel-6', 'panel-7', 'panel-8', 'panel-9', 'panel-10', 'panel-11'],
  )

  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.novelPromotionPanel.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.novelPromotionStoryboard.findMany.mockResolvedValue([group1, group2])
    prismaMock.novelPromotionPanel.findFirst.mockImplementation(async ({ where }: {
      where: { id?: string; storyboardId?: string; panelIndex?: number }
    }) => {
      const panels = [group1, group2].flatMap((group) => group.panels)
      return panels.find((candidate) => (
        where.id ? candidate.id === where.id : (
          candidate.storyboardId === where.storyboardId && candidate.panelIndex === where.panelIndex
        )
      )) ?? null
    })
  })

  it('stores a same-project manual replacement and returns source metadata', async () => {
    const response = await post({
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      action: 'replace',
      frame: 'last',
      sourcePanelId: 'panel-4',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      firstFrame: { mode: 'automatic', sourcePanelId: 'panel-0' },
      lastFrame: { mode: 'manual', sourcePanelId: 'panel-4' },
    })
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'panel-0',
        storyboard: expect.any(Object),
      }),
      data: expect.objectContaining({ linkedToNextPanel: true }),
    }))
  })

  it.each(['clear', 'unlink'] as const)('%s persists an explicit disabled link', async (action) => {
    const response = await post({
      storyboardId: 'storyboard-1', panelIndex: 0, action,
      ...(action === 'clear' ? { frame: 'last' } : {}),
    })

    expect(response.status).toBe(200)
    expect((await response.json()).lastFrame).toBeNull()
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        linkedToNextPanel: false,
        lastFrameSourceMeta: 'null',
      }),
    }))
  })

  it('restore-auto resolves cell 5 to the next continuous group from persisted order', async () => {
    const response = await post({
      storyboardId: 'storyboard-1', panelIndex: 5, action: 'restore-auto',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      firstFrame: { mode: 'automatic', sourcePanelId: 'panel-5' },
      lastFrame: { mode: 'automatic', sourcePanelId: 'panel-6' },
    })
  })

  it('returns not found when the target storyboard/panel is outside project and user scope', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce(null)

    const response = await post({
      storyboardId: 'foreign-storyboard', panelIndex: 0, action: 'restore-auto',
    })

    expect(response.status).toBe(404)
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        storyboard: expect.objectContaining({
          episode: expect.objectContaining({
            novelPromotionProject: expect.objectContaining({
              projectId: 'project-1',
              project: { userId: 'user-1' },
            }),
          }),
        }),
      }),
    }))
  })

  it('returns not found when a manual source panel is outside project and user scope', async () => {
    prismaMock.novelPromotionPanel.findFirst
      .mockResolvedValueOnce(group1.panels[0])
      .mockResolvedValueOnce(null)

    const response = await post({
      storyboardId: 'storyboard-1', panelIndex: 0, action: 'replace',
      frame: 'last', sourcePanelId: 'foreign-panel',
    })

    expect(response.status).toBe(404)
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })
})
