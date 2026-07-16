// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProfileManagement } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/assets/hooks/useProfileManagement'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
  characters: [] as Array<Record<string, unknown>>,
}))

const profileData = {
  role_level: 'A' as const,
  archetype: '冷静侦探',
  personality_tags: ['冷静'],
  era_period: '现代',
  social_class: '中产',
  occupation: '侦探',
  costume_tier: 3 as const,
  suggested_colors: ['黑色'],
  primary_identifier: '银框眼镜',
  visual_keywords: ['克制'],
  gender: '女',
  age_range: '25-30',
}

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/lib/query/hooks', () => ({
  useProjectAssets: () => ({
    data: {
      characters: mocks.characters,
    },
  }),
  useRefreshProjectAssets: () => mocks.refresh,
  useDeleteProjectCharacter: () => ({ mutateAsync: vi.fn() }),
  useConfirmProjectCharacterProfile: () => ({ mutateAsync: mocks.confirm }),
  useUpdateProjectCharacterProfile: () => ({ mutateAsync: mocks.update }),
  useBatchConfirmProjectCharacterProfiles: () => ({ mutateAsync: vi.fn() }),
}))

describe('confirmed profile management', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.update.mockResolvedValue({ success: true })
    mocks.characters = [{
      id: 'character-1',
      name: '林夏',
      profileConfirmed: true,
      profileData: JSON.stringify(profileData),
    }]
  })

  it('updates a confirmed profile without invoking confirmation or image regeneration', async () => {
    const { result, rerender } = renderHook(() => useProfileManagement({ projectId: 'project-1' }))

    await act(async () => {
      result.current.handleEditProfile('character-1', '林夏')
    })
    expect(result.current.editingProfile?.profileConfirmed).toBe(true)

    mocks.characters = []
    rerender()

    await act(async () => {
      await result.current.handleSaveProfile('character-1', profileData, true)
    })

    expect(mocks.update).toHaveBeenCalledWith({ characterId: 'character-1', profileData })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalled()
    expect(result.current.editingProfile).toBeNull()
  })

  it('opens a safe editable profile for a confirmed legacy character without profile data', async () => {
    mocks.characters = [{
      id: 'character-legacy',
      name: '旧角色',
      profileConfirmed: true,
      profileData: null,
    }]
    const { result } = renderHook(() => useProfileManagement({ projectId: 'project-1' }))

    await act(async () => {
      result.current.handleEditProfile('character-legacy', '旧角色')
    })

    expect(result.current.editingProfile).toMatchObject({
      characterId: 'character-legacy',
      profileConfirmed: true,
      profileData: {
        archetype: '旧角色',
        personality_tags: [],
        suggested_colors: [],
        visual_keywords: [],
      },
    })
  })
})
