import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const routeState = vi.hoisted(() => ({
  layoutMode: 'four_grid',
  configuredMode: 'four_grid',
  panelExists: false,
}))

const submitTaskMock = vi.hoisted(() => vi.fn(async () => ({
  success: true,
  async: true,
  taskId: 'task-1',
})))

const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: {
    findUnique: vi.fn(async () => ({
      id: 'episode-1',
      clips: [],
      novelPromotionProject: { storyboardGenerationMode: routeState.configuredMode },
    })),
  },
  novelPromotionStoryboard: {
    findFirst: vi.fn(async () => ({
      id: 'storyboard-1',
      layoutMode: routeState.layoutMode,
    })),
    findUnique: vi.fn(async () => ({
      id: 'storyboard-1',
      layoutMode: routeState.layoutMode,
      panels: [{ panelIndex: 3 }],
      episode: { novelPromotionProject: { projectId: 'project-1' } },
    })),
    update: vi.fn(async () => ({})),
  },
  novelPromotionPanel: {
    findUnique: vi.fn(async ({ where }: {
      where: { id?: string; storyboardId_panelIndex?: { storyboardId: string; panelIndex: number } }
    }) => {
      if (where.storyboardId_panelIndex && !routeState.panelExists) return null
      return {
      id: where.id || 'existing-panel',
      storyboardId: 'storyboard-1',
      panelIndex: where.id === 'panel-source' ? 1 : 2,
      shotType: 'medium',
      cameraMove: 'static',
      description: 'panel',
      videoPrompt: 'prompt',
      location: 'station',
      characters: '[]',
      srtSegment: '',
      duration: 3,
      storyboard: { layoutMode: routeState.layoutMode },
    }
    }),
    create: vi.fn(async () => ({ id: 'created-panel' })),
    count: vi.fn(async () => 5),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: routeState.panelExists ? 1 : 0 })),
  },
  $transaction: vi.fn(async () => {
    throw new Error('fixed-cardinality grid mutation reached transaction')
  }),
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
    project: { id: 'project-1', userId: 'user-1' },
  })),
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/task/resolve-locale', () => ({ resolveRequiredTaskLocale: vi.fn(() => 'en') }))
vi.mock('@/lib/billing', () => ({ buildDefaultTaskBillingInfo: vi.fn(() => ({ mode: 'default' })) }))
vi.mock('@/lib/config-service', () => ({
  getProjectModelConfig: vi.fn(async () => ({ storyboardModel: 'img::storyboard' })),
  buildImageBillingPayload: vi.fn(async ({ basePayload }: { basePayload: Record<string, unknown> }) => basePayload),
}))

async function expectGridMutationRejected(response: Response) {
  const json = await response.json() as { error: { code: string; details?: { code?: string } } }
  expect(response.status).toBe(400)
  expect(json.error.code).toBe('INVALID_PARAMS')
  expect(JSON.stringify(json)).toContain('GRID_PANEL_COUNT_FIXED')
}

describe('grid storyboard cardinality mutation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.layoutMode = 'four_grid'
    routeState.configuredMode = 'four_grid'
    routeState.panelExists = false
  })

  it('blocks appending a panel to a grid storyboard', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.POST(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel',
      method: 'POST',
      body: { storyboardId: 'storyboard-1' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.novelPromotionStoryboard.findUnique).toHaveBeenCalledWith({
      where: { id: 'storyboard-1' },
      include: { panels: { orderBy: { panelIndex: 'desc' }, take: 1 } },
    })
    expect(prismaMock.novelPromotionPanel.create).not.toHaveBeenCalled()
  })

  it('blocks deleting a panel from a grid storyboard', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.DELETE(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel?panelId=panel-1',
      method: 'DELETE',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('blocks legacy PATCH from creating a missing grid panel', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel',
      method: 'PATCH',
      body: { storyboardId: 'storyboard-1', panelIndex: 3, videoPrompt: 'updated prompt' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.novelPromotionPanel.create).not.toHaveBeenCalled()
  })

  it('allows legacy PATCH to edit an existing grid panel without changing cardinality', async () => {
    routeState.panelExists = true
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel',
      method: 'PATCH',
      body: { storyboardId: 'storyboard-1', panelIndex: 3, videoPrompt: 'updated prompt' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionPanel.updateMany).toHaveBeenCalledWith({
      where: { storyboardId: 'storyboard-1', panelIndex: 3 },
      data: { videoPrompt: 'updated prompt' },
    })
    expect(prismaMock.novelPromotionPanel.create).not.toHaveBeenCalled()
  })

  it('blocks PUT from creating a missing grid panel', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.PUT(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel',
      method: 'PUT',
      body: { storyboardId: 'storyboard-1', panelIndex: 3, description: 'updated panel' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.novelPromotionPanel.create).not.toHaveBeenCalled()
  })

  it('allows PUT to edit an existing grid panel without changing cardinality', async () => {
    routeState.panelExists = true
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await mod.PUT(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel',
      method: 'PUT',
      body: { storyboardId: 'storyboard-1', panelIndex: 3, description: 'updated panel' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'existing-panel' },
      data: { description: 'updated panel' },
    })
    expect(prismaMock.novelPromotionPanel.create).not.toHaveBeenCalled()
  })

  it('blocks inserting an AI panel into a grid storyboard', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/insert-panel/route')
    const response = await mod.POST(buildMockRequest({
      path: '/api/novel-promotion/project-1/insert-panel',
      method: 'POST',
      body: { storyboardId: 'storyboard-1', insertAfterPanelId: 'panel-1' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('blocks creating a variant panel in a grid storyboard', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel-variant/route')
    const response = await mod.POST(buildMockRequest({
      path: '/api/novel-promotion/project-1/panel-variant',
      method: 'POST',
      body: {
        storyboardId: 'storyboard-1',
        insertAfterPanelId: 'panel-insert',
        sourcePanelId: 'panel-source',
        variant: { video_prompt: 'variant prompt' },
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('blocks creating a one-panel storyboard group while the project is in grid mode', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
    const response = await mod.POST(buildMockRequest({
      path: '/api/novel-promotion/project-1/storyboard-group',
      method: 'POST',
      body: { episodeId: 'episode-1', insertIndex: 0 },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('blocks arbitrary storyboard text regeneration for a grid storyboard', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/regenerate-storyboard-text/route')
    const response = await mod.POST(buildMockRequest({
      path: '/api/novel-promotion/project-1/regenerate-storyboard-text',
      method: 'POST',
      body: { storyboardId: 'storyboard-1' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    await expectGridMutationRejected(response)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })
})
