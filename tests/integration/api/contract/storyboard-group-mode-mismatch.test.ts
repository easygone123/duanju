import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const routeState = vi.hoisted(() => ({
  configuredMode: 'four_grid',
  persistedLayouts: ['individual'] as string[],
}))

const txMock = vi.hoisted(() => ({
  clipCreate: vi.fn(async () => ({ id: 'clip-new' })),
  storyboardCreate: vi.fn(async () => ({ id: 'storyboard-new', layoutMode: 'individual' })),
  panelCreate: vi.fn(async () => ({ id: 'panel-new' })),
}))

const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: {
    findFirst: vi.fn(async () => ({
      id: 'episode-1',
      clips: [],
      storyboards: routeState.persistedLayouts.map((layoutMode) => ({ layoutMode })),
      novelPromotionProject: { storyboardGenerationMode: routeState.configuredMode },
    })),
    findUnique: vi.fn(async () => ({
      id: 'episode-1',
      clips: [],
      storyboards: routeState.persistedLayouts.map((layoutMode) => ({ layoutMode })),
      novelPromotionProject: { storyboardGenerationMode: routeState.configuredMode },
    })),
  },
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    novelPromotionClip: { create: txMock.clipCreate },
    novelPromotionStoryboard: { create: txMock.storyboardCreate },
    novelPromotionPanel: { create: txMock.panelCreate },
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

async function createGroup() {
  const { POST } = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
  return POST(buildMockRequest({
    path: '/api/novel-promotion/project-1/storyboard-group',
    method: 'POST',
    body: { episodeId: 'episode-1', insertIndex: 0 },
  }), { params: Promise.resolve({ projectId: 'project-1' }) })
}

describe('storyboard group creation during configured/persisted mode mismatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.configuredMode = 'four_grid'
    routeState.persistedLayouts = ['individual']
  })

  it('keeps persisted individual rows fully individual until a confirmed rebuild', async () => {
    const response = await createGroup()

    expect(response.status).toBe(200)
    expect(txMock.storyboardCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ layoutMode: 'individual', panelCount: 1 }),
    })
    expect(txMock.panelCreate).toHaveBeenCalled()
  })

  it('uses persisted grid rows instead of configured individual mode to block one-panel creation', async () => {
    routeState.configuredMode = 'individual'
    routeState.persistedLayouts = ['four_grid']

    const response = await createGroup()

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('uses configured grid mode only when the episode has no persisted storyboard rows', async () => {
    routeState.persistedLayouts = []

    const response = await createGroup()

    expect(response.status).toBe(400)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
