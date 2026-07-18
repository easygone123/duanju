import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const writes = vi.hoisted(() => ({
  transaction: vi.fn(async () => ({ id: 'unexpected-write' })),
  panelCreate: vi.fn(async () => ({ id: 'unexpected-panel' })),
  panelUpdate: vi.fn(async () => ({})),
  panelUpdateMany: vi.fn(async () => ({ count: 1 })),
  storyboardUpdate: vi.fn(async () => ({})),
}))

const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => ({
      id: 'foreign-episode',
      clips: [{ id: 'foreign-clip', createdAt: new Date('2026-07-18T00:00:00.000Z') }],
      storyboards: [{ layoutMode: 'individual' }],
      novelPromotionProject: { storyboardGenerationMode: 'individual' },
    })),
  },
  novelPromotionStoryboard: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => ({
      id: 'foreign-storyboard',
      clipId: 'foreign-clip',
      layoutMode: 'individual',
      panels: [{ id: 'foreign-panel', panelIndex: 0 }],
      clip: { id: 'foreign-clip' },
    })),
    update: writes.storyboardUpdate,
  },
  novelPromotionPanel: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => ({
      id: 'foreign-panel',
      storyboardId: 'foreign-storyboard',
      panelIndex: 0,
      storyboard: { layoutMode: 'individual' },
    })),
    create: writes.panelCreate,
    update: writes.panelUpdate,
    updateMany: writes.panelUpdateMany,
    count: vi.fn(async () => 1),
  },
  $transaction: writes.transaction,
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
    project: { id: 'path-project', userId: 'user-1' },
  })),
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
}

function expectNoWrites() {
  expect(writes.transaction).not.toHaveBeenCalled()
  expect(writes.panelCreate).not.toHaveBeenCalled()
  expect(writes.panelUpdate).not.toHaveBeenCalled()
  expect(writes.panelUpdateMany).not.toHaveBeenCalled()
  expect(writes.storyboardUpdate).not.toHaveBeenCalled()
}

describe('nested project ownership for storyboard mutation routes', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects panel POST when storyboard belongs to another path project', async () => {
    const { POST } = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await POST(buildMockRequest({
      path: '/api/novel-promotion/path-project/panel',
      method: 'POST',
      body: { storyboardId: 'foreign-storyboard' },
    }), { params: Promise.resolve({ projectId: 'path-project' }) })

    await expectNotFound(response)
    expect(prismaMock.novelPromotionStoryboard.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-storyboard',
        episode: { novelPromotionProject: { projectId: 'path-project' } },
      },
      include: { panels: { orderBy: { panelIndex: 'desc' }, take: 1 } },
    })
    expectNoWrites()
  })

  it('rejects panel DELETE when panel belongs to another path project', async () => {
    const { DELETE } = await import('@/app/api/novel-promotion/[projectId]/panel/route')
    const response = await DELETE(buildMockRequest({
      path: '/api/novel-promotion/path-project/panel?panelId=foreign-panel',
      method: 'DELETE',
    }), { params: Promise.resolve({ projectId: 'path-project' }) })

    await expectNotFound(response)
    expectNoWrites()
  })

  it.each(['PATCH', 'PUT'] as const)(
    'rejects legacy panel %s when storyboard belongs to another path project',
    async (method) => {
      const route = await import('@/app/api/novel-promotion/[projectId]/panel/route')
      const response = await route[method](buildMockRequest({
        path: '/api/novel-promotion/path-project/panel',
        method,
        body: { storyboardId: 'foreign-storyboard', panelIndex: 0, description: 'forbidden' },
      }), { params: Promise.resolve({ projectId: 'path-project' }) })

      await expectNotFound(response)
      expectNoWrites()
    },
  )

  it.each(['POST', 'PUT'] as const)(
    'rejects storyboard-group %s when episode belongs to another path project',
    async (method) => {
      const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
      const response = await route[method](buildMockRequest({
        path: '/api/novel-promotion/path-project/storyboard-group',
        method,
        body: method === 'POST'
          ? { episodeId: 'foreign-episode', insertIndex: 0 }
          : { episodeId: 'foreign-episode', clipId: 'foreign-clip', direction: 'down' },
      }), { params: Promise.resolve({ projectId: 'path-project' }) })

      await expectNotFound(response)
      expectNoWrites()
    },
  )

  it('rejects storyboard-group DELETE when storyboard belongs to another path project', async () => {
    const { DELETE } = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
    const response = await DELETE(buildMockRequest({
      path: '/api/novel-promotion/path-project/storyboard-group?storyboardId=foreign-storyboard',
      method: 'DELETE',
    }), { params: Promise.resolve({ projectId: 'path-project' }) })

    await expectNotFound(response)
    expectNoWrites()
  })
})
