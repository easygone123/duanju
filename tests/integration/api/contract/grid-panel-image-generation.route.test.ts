import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const routeState = vi.hoisted(() => ({
  layoutMode: 'individual' as 'individual' | 'four_grid' | 'six_grid',
  panelExists: true,
}))

const submitTaskMock = vi.hoisted(() => vi.fn(async () => ({
  taskId: 'task-1',
  async: true,
})))
const getProjectModelConfigMock = vi.hoisted(() => vi.fn(async () => ({
  storyboardModel: 'img::storyboard',
})))
const buildImageBillingPayloadMock = vi.hoisted(() => vi.fn(async ({
  basePayload,
}: {
  basePayload: Record<string, unknown>
}) => basePayload))
const resolveModelSelectionMock = vi.hoisted(() => vi.fn(async () => ({
  model: 'img::storyboard',
})))
const hasPanelImageOutputMock = vi.hoisted(() => vi.fn(async () => false))

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findFirst: vi.fn(async () => routeState.panelExists
      ? { id: 'panel-1', storyboard: { layoutMode: routeState.layoutMode } }
      : null),
  },
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
vi.mock('@/lib/task/resolve-locale', () => ({
  resolveRequiredTaskLocale: vi.fn(() => 'zh'),
}))
vi.mock('@/lib/config-service', () => ({
  getProjectModelConfig: getProjectModelConfigMock,
  buildImageBillingPayload: buildImageBillingPayloadMock,
}))
vi.mock('@/lib/api-config', () => ({
  resolveModelSelection: resolveModelSelectionMock,
}))
vi.mock('@/lib/task/has-output', () => ({
  hasPanelImageOutput: hasPanelImageOutputMock,
}))
vi.mock('@/lib/billing', () => ({
  buildDefaultTaskBillingInfo: vi.fn(() => ({ mode: 'default' })),
}))

async function invokeRoute() {
  const { POST } = await import('@/app/api/novel-promotion/[projectId]/regenerate-panel-image/route')
  return await POST(buildMockRequest({
    path: '/api/novel-promotion/project-1/regenerate-panel-image',
    method: 'POST',
    body: { panelId: 'panel-1', count: 1 },
  }), { params: Promise.resolve({ projectId: 'project-1' }) })
}

function expectNoGenerationWork() {
  expect(getProjectModelConfigMock).not.toHaveBeenCalled()
  expect(resolveModelSelectionMock).not.toHaveBeenCalled()
  expect(buildImageBillingPayloadMock).not.toHaveBeenCalled()
  expect(hasPanelImageOutputMock).not.toHaveBeenCalled()
  expect(submitTaskMock).not.toHaveBeenCalled()
}

describe('grid panel image generation route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.layoutMode = 'individual'
    routeState.panelExists = true
  })

  it('loads the panel through the authenticated owner and path project', async () => {
    const response = await invokeRoute()

    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionPanel.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'panel-1',
        storyboard: {
          episode: {
            novelPromotionProject: {
              projectId: 'project-1',
              project: { userId: 'user-1' },
            },
          },
        },
      },
      select: {
        id: true,
        storyboard: { select: { layoutMode: true } },
      },
    })
    expect(submitTaskMock).toHaveBeenCalledOnce()
  })

  it('returns not found for a missing or foreign panel before generation work', async () => {
    routeState.panelExists = false

    const response = await invokeRoute()

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expectNoGenerationWork()
  })

  it.each(['four_grid', 'six_grid'] as const)(
    'requires whole-sheet generation for a %s storyboard',
    async (layoutMode) => {
      routeState.layoutMode = layoutMode

      const response = await invokeRoute()

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {
          code: 'INVALID_PARAMS',
          details: {
            code: 'GRID_PANEL_INDIVIDUAL_GENERATION_UNSUPPORTED',
            field: 'panelId',
          },
        },
      })
      expectNoGenerationWork()
    },
  )
})
