import { describe, expect, it, vi } from 'vitest'
import { persistViralStoryboardGeneration } from '@/lib/viral-replication/persistence'

const generation = {
  schemaVersion: 1 as const,
  title: '原创标题', synopsis: '原创梗概', novelText: '原创正文', characters: [], locations: [],
  storyboards: [{
    sequence: 0, summary: '开场', panels: [{
      panelIndex: 0, sourceShotIndex: 0, startMs: 0, endMs: 2_000,
      durationSeconds: 2, shotType: '近景', cameraMove: '推进',
      location: '天台', characters: ['角色甲'], audioText: '原声对白',
      description: '角色抬头', imagePrompt: '原创画面提示词', videoPrompt: '原创视频提示词',
      sourceNarrativeFunction: '钩子',
    }],
  }],
}

describe('viral storyboard persistence', () => {
  it('atomically maps generated storyboards into editable script clips without creating final panels', async () => {
    const clipCreate = vi.fn(async () => ({ id: 'clip-1' }))
    const tx = {
      novelPromotionEpisode: {
        findFirst: vi.fn(async () => ({ id: 'episode-1', novelPromotionProjectId: 'novel-1', _count: { clips: 0, storyboards: 0 } })),
        update: vi.fn(async () => ({})),
      },
      novelPromotionCharacter: { create: vi.fn(async () => ({ id: 'character-1' })) },
      characterAppearance: { create: vi.fn(async () => ({})) },
      novelPromotionLocation: { create: vi.fn(async () => ({ id: 'location-1' })) },
      locationImage: { create: vi.fn(async () => ({})) },
      novelPromotionClip: { create: clipCreate },
      novelPromotionProject: { update: vi.fn(async () => ({})) },
      viralReplication: { updateMany: vi.fn(async () => ({ count: 1 })) },
    }
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) }

    await persistViralStoryboardGeneration({
      replicationId: 'rep-1', userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1', generation,
    }, db as never)

    expect(clipCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      start: 0,
      end: 2,
      duration: 2,
      shotCount: 1,
      characters: JSON.stringify(['角色甲']),
      location: '天台',
      content: expect.stringContaining('原声音频：原声对白'),
    }) })
    expect(tx.viralReplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'rep-1', userId: 'user-1', status: 'generating' },
      data: { status: 'completed', errorMessage: null },
    })
  })

  it('stores empty image histories as JSON strings for generated character appearances', async () => {
    const characterAppearanceCreate = vi.fn(async () => ({}))
    const tx = {
      novelPromotionEpisode: {
        findFirst: vi.fn(async () => ({ id: 'episode-1', novelPromotionProjectId: 'novel-1', _count: { clips: 0, storyboards: 0 } })),
        update: vi.fn(async () => ({})),
      },
      novelPromotionCharacter: { create: vi.fn(async () => ({ id: 'character-1' })) },
      characterAppearance: { create: characterAppearanceCreate },
      novelPromotionLocation: { create: vi.fn(async () => ({ id: 'location-1' })) },
      locationImage: { create: vi.fn(async () => ({})) },
      novelPromotionClip: { create: vi.fn(async () => ({ id: 'clip-1' })) },
      novelPromotionProject: { update: vi.fn(async () => ({})) },
      viralReplication: { updateMany: vi.fn(async () => ({ count: 1 })) },
    }
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) }

    await persistViralStoryboardGeneration({
      replicationId: 'rep-1',
      userId: 'user-1',
      projectId: 'project-1',
      episodeId: 'episode-1',
      generation: {
        ...generation,
        characters: [{ name: '角色甲', description: '年轻程序员' }],
      },
    }, db as never)

    expect(characterAppearanceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        imageUrls: '[]',
        previousImageUrls: '[]',
      }),
    })
  })

  it('fails closed when the draft episode already contains clips or storyboards', async () => {
    const tx = {
      novelPromotionEpisode: { findFirst: vi.fn(async () => ({ id: 'episode-1', novelPromotionProjectId: 'novel-1', _count: { clips: 1, storyboards: 0 } })) },
    }
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) }
    await expect(persistViralStoryboardGeneration({
      replicationId: 'rep-1', userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1', generation,
    }, db as never)).rejects.toThrow('VIRAL_EPISODE_NOT_EMPTY')
  })
})
