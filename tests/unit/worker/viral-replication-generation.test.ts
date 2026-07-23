import { describe, expect, it, vi } from 'vitest'
import { createViralReplicationGenerationHandler } from '@/lib/workers/handlers/viral-replication-generation'

function completion(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] }
}

describe('viral replication generation worker', () => {
  it('uses the pinned model and latest brief, validates output, then persists it', async () => {
    const generation = {
      schemaVersion: 1, title: '原创标题', synopsis: '梗概', novelText: '正文', characters: [], locations: [],
      storyboards: [{ sequence: 0, summary: '开场', panels: [{
        panelIndex: 0, sourceShotIndex: 0, startMs: 0, endMs: 15_000, durationSeconds: 15,
        shotType: '近景', cameraMove: '推进', location: '天台', characters: [], audioText: null,
        description: '原创画面', imagePrompt: '图像提示',
        videoPrompt: '视频提示', sourceNarrativeFunction: '钩子' }] }],
    }
    const persist = vi.fn(async () => undefined)
    const runText = vi.fn(async (input: unknown) => {
      void input
      return completion(JSON.stringify(generation)) as never
    })
    const replication = {
      id: 'rep-1', userId: 'user-1', projectId: 'project-1', episodeId: 'episode-1',
      sourceVideoMediaId: 'source-media-1',
      status: 'generating', brief: '最新原创方向', videoRatio: '9:16', artStyle: 'realistic',
      analysisModelSnapshot: 'provider::pinned', durationMs: 15_000,
      transcriptText: null,
      reportJson: { schemaVersion: 1, overview: { hook: 'hook', coreAppeal: 'appeal', pacing: 'fast', emotionalArc: 'rise' },
        styleFingerprint: { composition: [], lighting: [], color: [], editing: [] },
        shots: [{ shotIndex: 0, startMs: 0, endMs: 15_000, shotType: 'wide', cameraAngle: 'eye', cameraMove: 'static', composition: 'center', actionBeat: 'action', transition: 'cut', subtitleSummary: null, narrativeFunction: 'hook' }], originalAdaptationAdvice: [] },
    }
    const handler = createViralReplicationGenerationHandler({
      prisma: { viralReplication: { findFirst: vi.fn(async () => replication), updateMany: vi.fn(async () => ({ count: 1 })) } },
      runText, persist, reportProgress: vi.fn(async () => undefined),
    } as never)
    const job = { data: { targetId: 'rep-1', userId: 'user-1', projectId: 'project-1', taskId: 'task-1', locale: 'zh', payload: { analysisModelSnapshot: 'provider::pinned' } } }

    await handler(job as never)

    expect(runText).toHaveBeenCalledWith(expect.objectContaining({ model: 'provider::pinned' }))
    expect(JSON.stringify(runText.mock.calls[0][0])).toContain('最新原创方向')
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ generation }))
  })
})
