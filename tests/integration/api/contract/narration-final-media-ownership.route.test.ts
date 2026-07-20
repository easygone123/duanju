import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn(async () => ({ taskId: 'task-1', async: true })))
const mediaMock = vi.hoisted(() => ({
  resolveMediaRef: vi.fn(async () => null),
  resolveMediaRefFromLegacyValue: vi.fn(async () => null),
  resolveStorageKeyFromMediaValue: vi.fn(async () => null),
}))
const prismaMock = vi.hoisted(() => ({
  userPreference: { findUnique: vi.fn(async () => ({ lipSyncModel: 'fal::lip-sync' })) },
  novelPromotionEpisode: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  novelPromotionPanel: { findFirst: vi.fn() },
  novelPromotionVoiceLine: {
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  novelPromotionProject: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: authMock,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/task/has-output', () => ({ hasPanelLipSyncOutput: vi.fn(async () => false) }))
vi.mock('@/lib/media/attach', () => ({ attachMediaFieldsToProject: vi.fn(async (value: unknown) => value) }))
vi.mock('@/lib/media/service', () => mediaMock)

import { GET as getVoiceLines, PATCH as patchVoiceLines } from '@/app/api/novel-promotion/[projectId]/voice-lines/route'
import { GET as downloadVoices } from '@/app/api/novel-promotion/[projectId]/download-voices/route'
import { POST as submitLipSync } from '@/app/api/novel-promotion/[projectId]/lip-sync/route'
import { POST as downloadVideos } from '@/app/api/novel-promotion/[projectId]/download-videos/route'
import { POST as getVideoUrls } from '@/app/api/novel-promotion/[projectId]/video-urls/route'
import { GET as proxyVideo } from '@/app/api/novel-promotion/[projectId]/video-proxy/route'
import {
  GET as getEpisode,
  PATCH as patchEpisode,
  DELETE as deleteEpisode,
} from '@/app/api/novel-promotion/[projectId]/episodes/[episodeId]/route'

const context = { params: Promise.resolve({ projectId: 'project-1' }) }
const episodeContext = { params: Promise.resolve({ projectId: 'project-1', episodeId: 'foreign-episode' }) }

async function expectNotFound(response: Response) {
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
}

describe('narration and final-media route ownership boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      project: { id: 'project-1', userId: 'user-1', name: 'Project' },
    })
    prismaMock.novelPromotionEpisode.findFirst.mockResolvedValue(null)
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValue(null)
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValue(null)
  })

  it('fails closed before listing or bulk-editing voice lines for a foreign episode id', async () => {
    await expectNotFound(await getVoiceLines(buildMockRequest({
      path: '/api/novel-promotion/project-1/voice-lines?episodeId=foreign-episode',
      method: 'GET',
    }), context))
    await expectNotFound(await patchVoiceLines(buildMockRequest({
      path: '/api/novel-promotion/project-1/voice-lines',
      method: 'PATCH',
      body: { episodeId: 'foreign-episode', speaker: 'Narrator', voicePresetId: null },
    }), context))

    expect(prismaMock.novelPromotionVoiceLine.findMany).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionEpisode.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'foreign-episode',
        novelPromotionProject: { projectId: 'project-1' },
      },
    }))
  })

  it('does not fall back to project-wide voice downloads for a foreign episode id', async () => {
    await expectNotFound(await downloadVoices(buildMockRequest({
      path: '/api/novel-promotion/project-1/download-voices?episodeId=foreign-episode',
      method: 'GET',
    }), context))

    expect(prismaMock.novelPromotionVoiceLine.findMany).not.toHaveBeenCalled()
  })

  it('requires both an owned panel and its enabled matched voice line for lip sync', async () => {
    await expectNotFound(await submitLipSync(buildMockRequest({
      path: '/api/novel-promotion/project-1/lip-sync',
      method: 'POST',
      body: { storyboardId: 'foreign-storyboard', panelIndex: 0, voiceLineId: 'line-1' },
    }), context))
    expect(submitTaskMock).not.toHaveBeenCalled()

    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      storyboard: { episodeId: 'episode-1' },
    })
    await expectNotFound(await submitLipSync(buildMockRequest({
      path: '/api/novel-promotion/project-1/lip-sync',
      method: 'POST',
      body: { storyboardId: 'storyboard-1', panelIndex: 0, voiceLineId: 'foreign-line' },
    }), context))

    expect(prismaMock.novelPromotionVoiceLine.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'foreign-line',
        episodeId: 'episode-1',
        enabled: true,
        OR: expect.arrayContaining([
          { matchedPanelId: 'panel-1' },
          expect.objectContaining({
            lineType: 'dialogue',
            matchedStoryboardId: 'storyboard-1',
            matchedPanelIndex: 0,
          }),
        ]),
        episode: expect.objectContaining({
          novelPromotionProject: { projectId: 'project-1' },
        }),
      }),
      select: { id: true },
    })
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('accepts an owned enabled legacy dialogue matched by storyboard and panel index', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      storyboard: { episodeId: 'episode-1' },
    })
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValueOnce({ id: 'legacy-line' })

    const response = await submitLipSync(buildMockRequest({
      path: '/api/novel-promotion/project-1/lip-sync',
      method: 'POST',
      body: { storyboardId: 'storyboard-1', panelIndex: 0, voiceLineId: 'legacy-line' },
    }), context)

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalled()
    expect(prismaMock.novelPromotionVoiceLine.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        enabled: true,
        OR: expect.arrayContaining([{
          lineType: 'dialogue',
          matchedPanelId: null,
          matchedStoryboardId: 'storyboard-1',
          matchedPanelIndex: 0,
        }]),
      }),
    }))
  })

  it.each([
    ['a legacy line with the wrong storyboard/index', 'wrong-legacy-line'],
    ['a disabled legacy line', 'disabled-legacy-line'],
    ['a cross-project legacy line', 'foreign-legacy-line'],
  ])('rejects %s before submitting lip sync', async (_label, voiceLineId) => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      storyboard: { episodeId: 'episode-1' },
    })
    prismaMock.novelPromotionVoiceLine.findFirst.mockResolvedValueOnce(null)

    await expectNotFound(await submitLipSync(buildMockRequest({
      path: '/api/novel-promotion/project-1/lip-sync',
      method: 'POST',
      body: { storyboardId: 'storyboard-1', panelIndex: 0, voiceLineId },
    }), context))

    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('fails closed for foreign episode ids on final-video endpoints', async () => {
    await expectNotFound(await downloadVideos(buildMockRequest({
      path: '/api/novel-promotion/project-1/download-videos',
      method: 'POST',
      body: { episodeId: 'foreign-episode' },
    }), context))
    await expectNotFound(await getVideoUrls(buildMockRequest({
      path: '/api/novel-promotion/project-1/video-urls',
      method: 'POST',
      body: { episodeId: 'foreign-episode' },
    }), context))

    expect(prismaMock.novelPromotionEpisode.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'foreign-episode', novelPromotionProject: { projectId: 'project-1' } },
    }))
  })

  it('does not proxy a media key that is not referenced by a panel in the path project', async () => {
    await expectNotFound(await proxyVideo(buildMockRequest({
      path: '/api/novel-promotion/project-1/video-proxy?key=foreign/video.mp4',
      method: 'GET',
    }), context))

    expect(prismaMock.novelPromotionPanel.findFirst).toHaveBeenCalledWith({
      where: {
        storyboard: { episode: { novelPromotionProject: { projectId: 'project-1' } } },
        OR: [
          { videoUrl: 'foreign/video.mp4' },
          { lipSyncVideoUrl: 'foreign/video.mp4' },
        ],
      },
      select: { id: true },
    })
  })

  it('does not read, mutate, or delete an episode outside the path project', async () => {
    await expectNotFound(await getEpisode(buildMockRequest({
      path: '/api/novel-promotion/project-1/episodes/foreign-episode',
      method: 'GET',
    }), episodeContext))
    await expectNotFound(await patchEpisode(buildMockRequest({
      path: '/api/novel-promotion/project-1/episodes/foreign-episode',
      method: 'PATCH',
      body: { name: 'forged' },
    }), episodeContext))
    await expectNotFound(await deleteEpisode(buildMockRequest({
      path: '/api/novel-promotion/project-1/episodes/foreign-episode',
      method: 'DELETE',
    }), episodeContext))

    expect(prismaMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionEpisode.delete).not.toHaveBeenCalled()
    expect(mediaMock.resolveMediaRefFromLegacyValue).not.toHaveBeenCalled()
  })

  it('does not resolve foreign episode media before ownership succeeds', async () => {
    await expectNotFound(await patchEpisode(buildMockRequest({
      path: '/api/novel-promotion/project-1/episodes/foreign-episode',
      method: 'PATCH',
      body: { audioUrl: '/m/foreign-audio' },
    }), episodeContext))

    expect(mediaMock.resolveMediaRefFromLegacyValue).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
  })

  it('returns an auth response before touching scoped data', async () => {
    authMock.mockResolvedValueOnce(NextResponse.json({ code: 'AUTH_REQUIRED' }, { status: 401 }))
    const response = await getVoiceLines(buildMockRequest({
      path: '/api/novel-promotion/project-1/voice-lines?episodeId=episode-1',
      method: 'GET',
    }), context)
    expect(response.status).toBe(401)
    expect(prismaMock.novelPromotionEpisode.findFirst).not.toHaveBeenCalled()
  })
})
