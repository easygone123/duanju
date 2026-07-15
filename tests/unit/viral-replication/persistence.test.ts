import { describe, expect, it, vi } from 'vitest'
import { persistViralStoryboardGeneration } from '@/lib/viral-replication/persistence'

const generation = {
  schemaVersion: 1 as const,
  title: '原创标题', synopsis: '原创梗概', novelText: '原创正文', characters: [],
  storyboards: [{
    sequence: 0, summary: '开场', panels: [{
      panelIndex: 0, durationSeconds: 2, shotType: '近景', cameraMove: '推进',
      description: '角色抬头', imagePrompt: '原创画面提示词', videoPrompt: '原创视频提示词',
      sourceNarrativeFunction: '钩子',
    }],
  }],
}

describe('viral storyboard persistence', () => {
  it('atomically maps generated storyboards into editable episode rows without submitting media tasks', async () => {
    const panelCreate = vi.fn(async () => ({ id: 'panel-1' }))
    const tx = {
      novelPromotionEpisode: {
        findFirst: vi.fn(async () => ({ id: 'episode-1', novelPromotionProjectId: 'novel-1', _count: { clips: 0, storyboards: 0 } })),
        update: vi.fn(async () => ({})),
      },
      novelPromotionClip: { create: vi.fn(async () => ({ id: 'clip-1' })) },
      novelPromotionStoryboard: { create: vi.fn(async () => ({ id: 'storyboard-1' })) },
      novelPromotionPanel: { create: panelCreate },
      novelPromotionProject: { update: vi.fn(async () => ({})) },
      viralReplication: { updateMany: vi.fn(async () => ({ count: 1 })) },
    }
    const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) }

    await persistViralStoryboardGeneration({
      replicationId: 'rep-1', userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1', generation,
    }, db as never)

    expect(panelCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      panelIndex: 0, panelNumber: 1, duration: 2, shotType: '近景', cameraMove: '推进',
      description: '角色抬头', imagePrompt: '原创画面提示词', videoPrompt: '原创视频提示词',
    }) })
    expect(tx.viralReplication.updateMany).toHaveBeenCalledWith({
      where: { id: 'rep-1', userId: 'user-1', status: 'generating' },
      data: { status: 'completed', errorMessage: null },
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
