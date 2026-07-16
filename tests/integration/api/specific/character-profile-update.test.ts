import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRoute } from '../helpers/call-route'

const prismaMock = vi.hoisted(() => ({
  novelPromotionCharacter: {
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
}))

vi.mock('@/lib/api-auth', () => ({
  requireProjectAuth: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
    novelData: { id: 'novel-1' },
  })),
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/llm-observe/route-task', () => ({ maybeSubmitLLMTask: vi.fn() }))

const profileData = {
  role_level: 'A',
  archetype: '冷静侦探',
  personality_tags: ['冷静'],
  era_period: '现代',
  social_class: '中产',
  occupation: '侦探',
  costume_tier: 3,
  suggested_colors: ['黑色'],
  primary_identifier: '银框眼镜',
  visual_keywords: ['克制'],
  gender: '女',
  age_range: '25-30',
}

describe('confirmed character profile update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.novelPromotionCharacter.updateMany.mockResolvedValue({ count: 1 })
  })

  it('updates the confirmed profile in its owning project without regenerating appearances', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/character-profile/confirm/route')
    const patch = (route as unknown as { PATCH?: Parameters<typeof callRoute>[0] }).PATCH

    expect(patch).toBeTypeOf('function')
    if (!patch) return

    const response = await callRoute(patch, 'PATCH', {
      characterId: 'character-1',
      profileData,
    }, { params: { projectId: 'project-1' } })

    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionCharacter.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'character-1',
        novelPromotionProjectId: 'novel-1',
        profileConfirmed: true,
      },
      data: { profileData: JSON.stringify(profileData) },
    })
  })

  it('does not update an unconfirmed or out-of-project character', async () => {
    prismaMock.novelPromotionCharacter.updateMany.mockResolvedValueOnce({ count: 0 })
    const route = await import('@/app/api/novel-promotion/[projectId]/character-profile/confirm/route')

    const response = await callRoute(route.PATCH, 'PATCH', {
      characterId: 'character-outside-project',
      profileData,
    }, { params: { projectId: 'project-1' } })

    expect(response.status).toBe(404)
  })

  it('rejects structurally invalid profile arrays before persistence', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/character-profile/confirm/route')
    const response = await callRoute(route.PATCH, 'PATCH', {
      characterId: 'character-1',
      profileData: { ...profileData, personality_tags: ['冷静', 42] },
    }, { params: { projectId: 'project-1' } })

    expect(response.status).toBe(400)
    expect(prismaMock.novelPromotionCharacter.updateMany).not.toHaveBeenCalled()
  })
})
