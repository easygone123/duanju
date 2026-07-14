import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => vi.fn())
const attachMediaMock = vi.hoisted(() => vi.fn(async (value: unknown) => value))
const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: {
    findFirst: vi.fn(),
  },
  novelPromotionClip: { count: vi.fn() },
  novelPromotionStoryboard: { count: vi.fn() },
  novelPromotionPanel: { count: vi.fn() },
  novelPromotionVoiceLine: { count: vi.fn() },
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: authMock,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/media/attach', () => ({ attachMediaFieldsToStagePayload: attachMediaMock }))

type JsonObject = Record<string, unknown>

const hugeHistory = 'x'.repeat(300_000)
const fixture: JsonObject = {
  id: 'episode-1',
  novelPromotionProjectId: 'novel-project-1',
  episodeNumber: 7,
  name: 'Episode 7',
  description: 'large compatibility-only description',
  novelText: 'A compact story',
  audioUrl: 'legacy-audio.mp3',
  audioMediaId: 'audio-media-1',
  speakerVoices: '{"Alice":{"voiceId":"v1"}}',
  createdAt: new Date('2026-07-14T01:00:00.000Z'),
  updatedAt: new Date('2026-07-14T02:00:00.000Z'),
  clips: [
    {
      id: 'clip-2', episodeId: 'episode-1', start: 5, end: 10, duration: 5,
      summary: 'second', location: 'office', content: 'second clip', characters: '["Bob"]',
      props: '["phone"]', endText: 'z', shotCount: 1, startText: 'y', screenplay: '{"scene":2}',
      createdAt: new Date('2026-07-14T01:02:00.000Z'), updatedAt: new Date('2026-07-14T01:03:00.000Z'),
    },
    {
      id: 'clip-1', episodeId: 'episode-1', start: 0, end: 5, duration: 5,
      summary: 'first', location: 'home', content: 'first clip', characters: '["Alice"]',
      props: '[]', endText: 'b', shotCount: 1, startText: 'a', screenplay: '{"scene":1}',
      createdAt: new Date('2026-07-14T01:01:00.000Z'), updatedAt: new Date('2026-07-14T01:04:00.000Z'),
    },
  ],
  storyboards: [
    {
      id: 'storyboard-2', episodeId: 'episode-1', clipId: 'clip-2', panelCount: 1,
      storyboardTextJson: hugeHistory, imageHistory: hugeHistory, candidateImages: hugeHistory,
      storyboardImageUrl: 'legacy-board-2.jpg', createdAt: new Date('2026-07-14T01:06:00.000Z'),
      updatedAt: new Date('2026-07-14T01:07:00.000Z'), layoutMode: 'individual', groupSequence: null,
      continuityAnchor: null, panels: [{
        id: 'panel-2', storyboardId: 'storyboard-2', panelIndex: 1, description: 'second panel',
        srtSegment: 'second line', imagePrompt: 'image two', imageUrl: 'legacy-image-2.jpg',
        imageMediaId: 'image-media-2', imageHistory: hugeHistory, candidateImages: null,
        videoPrompt: 'video two', videoUrl: 'legacy-video-2.mp4', videoMediaId: 'video-media-2',
        lipSyncVideoUrl: null, lipSyncVideoMediaId: null, linkedToNextPanel: false,
        firstFrameSourceMeta: null, lastFrameSourceMeta: null, hasDialogue: false,
        dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, createdAt: new Date('2026-07-14T01:06:00.000Z'),
        updatedAt: new Date('2026-07-14T01:07:00.000Z'),
      }],
    },
    {
      id: 'storyboard-1', episodeId: 'episode-1', clipId: 'clip-1', panelCount: 2,
      storyboardTextJson: hugeHistory, imageHistory: hugeHistory, candidateImages: hugeHistory,
      storyboardImageUrl: 'legacy-board-1.jpg', createdAt: new Date('2026-07-14T01:04:00.000Z'),
      updatedAt: new Date('2026-07-14T01:05:00.000Z'), layoutMode: 'individual', groupSequence: null,
      continuityAnchor: '{"sceneKey":"home"}', panels: [
        {
          id: 'panel-1b', storyboardId: 'storyboard-1', panelIndex: 1, description: 'later panel',
          srtSegment: 'later', imagePrompt: 'later image', imageUrl: null, imageMediaId: null,
          imageHistory: hugeHistory, candidateImages: null, videoPrompt: 'later video', videoUrl: null,
          videoMediaId: null, lipSyncVideoUrl: null, lipSyncVideoMediaId: null,
          linkedToNextPanel: false, firstFrameSourceMeta: null, lastFrameSourceMeta: null,
          hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
          includeDialogueInVideoPrompt: true, createdAt: new Date('2026-07-14T01:04:00.000Z'),
          updatedAt: new Date('2026-07-14T01:05:00.000Z'),
        },
        {
          id: 'panel-1a', storyboardId: 'storyboard-1', panelIndex: 0, description: 'first panel',
          srtSegment: 'hello', imagePrompt: 'first image', imageUrl: 'legacy-image-1.jpg',
          imageMediaId: 'image-media-1', imageHistory: hugeHistory, candidateImages: '["candidate.jpg"]',
          videoPrompt: 'first video', videoUrl: 'legacy-video-1.mp4', videoMediaId: 'video-media-1',
          lipSyncVideoUrl: 'legacy-lipsync-1.mp4', lipSyncVideoMediaId: 'lipsync-media-1',
          linkedToNextPanel: true, firstFrameSourceMeta: '{"mode":"automatic"}',
          lastFrameSourceMeta: '{"mode":"automatic"}', hasDialogue: true,
          dialogueSpeaker: 'Alice', dialogueText: 'hello', dialogueEmotion: 'happy',
          includeDialogueInVideoPrompt: true, createdAt: new Date('2026-07-14T01:04:00.000Z'),
          updatedAt: new Date('2026-07-14T01:05:00.000Z'),
        },
      ],
    },
  ],
  voiceLines: [{
    id: 'voice-1', episodeId: 'episode-1', lineIndex: 1, speaker: 'Alice', content: 'hello',
    audioUrl: 'legacy-voice.mp3', audioMediaId: 'voice-media-1', updatedAt: new Date('2026-07-14T01:08:00.000Z'),
  }],
  shots: [{ id: 'shot-1', plot: hugeHistory }],
}

function compareOrder(left: JsonObject, right: JsonObject, orderBy: JsonObject) {
  const [field, direction] = Object.entries(orderBy)[0] as [string, unknown]
  const a = left[field] instanceof Date ? (left[field] as Date).getTime() : left[field]
  const b = right[field] instanceof Date ? (right[field] as Date).getTime() : right[field]
  if (a === b) return 0
  const result = (a as string | number) < (b as string | number) ? -1 : 1
  return direction === 'desc' ? -result : result
}

function applySelect(row: JsonObject, select: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(select).flatMap(([field, rule]) => {
    if (rule === true) return [[field, row[field]]]
    if (!rule || typeof rule !== 'object') return []
    const nested = rule as { select?: JsonObject; orderBy?: JsonObject; take?: number }
    const value = row[field]
    if (Array.isArray(value)) {
      let values = [...value] as JsonObject[]
      if (nested.orderBy) values.sort((a, b) => compareOrder(a, b, nested.orderBy!))
      if (nested.take) values = values.slice(0, nested.take)
      return [[field, nested.select ? values.map((item) => applySelect(item, nested.select!)) : values]]
    }
    if (value && typeof value === 'object' && nested.select) {
      return [[field, applySelect(value as JsonObject, nested.select)]]
    }
    return [[field, value]]
  }))
}

async function get(stage: string | undefined, projectId = 'project-1', episodeId = 'episode-1') {
  const { GET } = await import('@/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route')
  return GET(buildMockRequest({
    path: `/api/novel-promotion/${projectId}/episodes/${episodeId}/stage/${stage ?? ''}`,
    method: 'GET',
  }), { params: Promise.resolve({ projectId, episodeId, stage }) })
}

describe('episode stage data route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      project: { id: 'project-1', userId: 'user-1' },
    })
    prismaMock.novelPromotionEpisode.findFirst.mockImplementation(async ({ select }: { select: JsonObject }) => (
      applySelect(fixture, select)
    ))
    prismaMock.novelPromotionClip.count.mockResolvedValue(2)
    prismaMock.novelPromotionStoryboard.count.mockResolvedValue(2)
    prismaMock.novelPromotionPanel.count.mockImplementation(async ({ where }: { where: JsonObject }) => (
      where.videoUrl ? 2 : 3
    ))
    prismaMock.novelPromotionVoiceLine.count.mockResolvedValue(1)
  })

  it.each(['config', 'script', 'storyboard', 'videos', 'voice'] as const)(
    'returns the isolated %s projection for an owned episode',
    async (stage) => {
      const response = await get(stage)
      expect(response.status).toBe(200)
      const body = await response.json()

      expect(body.stage).toBe(stage)
      expect(body.episode.id).toBe('episode-1')
      expect(prismaMock.novelPromotionEpisode.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          id: 'episode-1',
          novelPromotionProject: { projectId: 'project-1' },
        },
        select: expect.any(Object),
      }))
      expect(JSON.stringify(body)).not.toContain('large compatibility-only description')
      expect(JSON.stringify(body)).not.toContain('shot-1')

      if (stage === 'config') {
        expect(body.episode).toMatchObject({
          id: 'episode-1', name: 'Episode 7', novelText: 'A compact story',
          readiness: { hasStory: true, hasScript: true, hasStoryboard: true, hasVideo: true, hasVoice: true },
        })
        expect(body.episode).not.toHaveProperty('clips')
        expect(body.episode).not.toHaveProperty('storyboards')
        expect(body.episode).not.toHaveProperty('voiceLines')
      } else {
        expect(body.episode).not.toHaveProperty('novelText')
      }

      if (stage === 'script') {
        expect(body.episode.clips.map((clip: JsonObject) => clip.id)).toEqual(['clip-1', 'clip-2'])
        expect(body.episode.clips[0]).toMatchObject({ screenplay: '{"scene":1}', characters: '["Alice"]' })
        expect(body.episode).not.toHaveProperty('storyboards')
        expect(body.episode).not.toHaveProperty('voiceLines')
      }

      if (stage === 'storyboard' || stage === 'videos' || stage === 'voice') {
        expect(body.episode.clips.map((clip: JsonObject) => clip.id)).toEqual(['clip-1', 'clip-2'])
        expect(body.episode.storyboards.map((storyboard: JsonObject) => storyboard.id)).toEqual([
          'storyboard-1', 'storyboard-2',
        ])
        expect(body.episode.storyboards[0].panels.map((panel: JsonObject) => panel.id)).toEqual([
          'panel-1a', 'panel-1b',
        ])
      }

      if (stage === 'storyboard') {
        expect(body.episode.storyboards[0].panels[0]).toMatchObject({
          imageUrl: 'legacy-image-1.jpg', imageMediaId: 'image-media-1', candidateImages: '["candidate.jpg"]',
          videoPrompt: 'first video', hasDialogue: true,
        })
        expect(JSON.stringify(body)).not.toContain(hugeHistory)
        expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(250_000)
        expect(body.episode).not.toHaveProperty('voiceLines')
      }

      if (stage === 'videos') {
        expect(body.episode.storyboards[0].panels[0]).toMatchObject({
          videoPrompt: 'first video', videoUrl: 'legacy-video-1.mp4', videoMediaId: 'video-media-1',
          lipSyncVideoMediaId: 'lipsync-media-1', dialogueText: 'hello', linkedToNextPanel: true,
          updatedAt: '2026-07-14T01:05:00.000Z',
        })
        expect(body.episode).not.toHaveProperty('voiceLines')
      }

      if (stage === 'voice') {
        expect(body.episode.storyboards[0].panels[0]).toEqual(expect.objectContaining({
          id: 'panel-1a', panelIndex: 0, srtSegment: 'hello', description: 'first panel',
        }))
        expect(body.episode.storyboards[0].panels[0]).not.toHaveProperty('videoPrompt')
        expect(body.episode).not.toHaveProperty('voiceLines')
        expect(body.episode).not.toHaveProperty('speakerVoices')
      }
    },
  )

  it.each([undefined, '', 'assets', 'editor', 'text-storyboard', 'unknown'])(
    'rejects missing, legacy, or unknown stage %s',
    async (stage) => {
      const response = await get(stage)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
      expect(prismaMock.novelPromotionEpisode.findFirst).not.toHaveBeenCalled()
    },
  )

  it('returns the project auth response before reading episode data', async () => {
    authMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }))
    const response = await get('config')
    expect(response.status).toBe(401)
    expect(prismaMock.novelPromotionEpisode.findFirst).not.toHaveBeenCalled()
  })

  it('loads config readiness and storyboard stats without selecting relation arrays', async () => {
    const response = await get('config')
    expect(response.status).toBe(200)
    const body = await response.json()

    const select = prismaMock.novelPromotionEpisode.findFirst.mock.calls[0]?.[0]?.select
    expect(select).toEqual({ id: true, episodeNumber: true, name: true, novelText: true })
    expect(prismaMock.novelPromotionClip.count).toHaveBeenCalledTimes(1)
    expect(prismaMock.novelPromotionStoryboard.count).toHaveBeenCalledTimes(1)
    expect(prismaMock.novelPromotionPanel.count).toHaveBeenCalledTimes(2)
    expect(prismaMock.novelPromotionVoiceLine.count).toHaveBeenCalledTimes(1)
    expect(body.episode).toMatchObject({
      readiness: { hasStory: true, hasScript: true, hasStoryboard: true, hasVideo: true, hasVoice: true },
      storyboardStats: { storyboardCount: 2, panelCount: 3 },
    })
  })

  it('returns 404 when the episode is not owned by the route project', async () => {
    prismaMock.novelPromotionEpisode.findFirst.mockResolvedValueOnce(null)
    const response = await get('storyboard', 'project-2')
    expect(response.status).toBe(404)
    expect(prismaMock.novelPromotionEpisode.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'episode-1', novelPromotionProject: { projectId: 'project-2' } },
    }))
  })

  it('passes media-bearing stage payloads through the shared ownership resolver', async () => {
    await get('storyboard')
    expect(attachMediaMock).toHaveBeenCalledTimes(1)
    expect(attachMediaMock).toHaveBeenCalledWith(expect.objectContaining({
      storyboards: expect.any(Array),
    }))
  })
})
