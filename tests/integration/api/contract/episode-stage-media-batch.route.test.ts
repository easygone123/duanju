import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => vi.fn())
const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: { findFirst: vi.fn() },
  mediaObject: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuthLight: authMock,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/storage', () => ({
  extractStorageKey: (value: string) => value.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, ''),
}))

const mediaRow = (id: string, publicId: string, storageKey: string) => ({
  id,
  publicId,
  storageKey,
  sha256: null,
  mimeType: 'image/png',
  sizeBytes: 100,
  width: 1024,
  height: 1024,
  durationMs: null,
  updatedAt: new Date('2026-07-14T00:00:00.000Z'),
})

const panelCount = 48
const mediaRows = Array.from({ length: panelCount }, (_, index) => (
  mediaRow(`image-${index}`, `public-image-${index}`, `panels/image-${index}.png`)
))

const episode = {
  id: 'episode-1',
  episodeNumber: 1,
  name: 'Episode 1',
  clips: [],
  storyboards: [{
    id: 'storyboard-1',
    episodeId: 'episode-1',
    clipId: null,
    storyboardImageUrl: null,
    sheetImageUrl: null,
    sheetImageMediaId: null,
    upscaledSheetImageUrl: null,
    upscaledSheetImageMediaId: null,
    panels: Array.from({ length: panelCount }, (_, index) => ({
      id: `panel-${index}`,
      storyboardId: 'storyboard-1',
      panelIndex: index,
      imageMediaId: `image-${index}`,
      imageUrl: `stale/image-${index}.png`,
      videoMediaId: null,
      videoUrl: null,
      lipSyncVideoMediaId: null,
      lipSyncVideoUrl: null,
      sketchImageMediaId: null,
      sketchImageUrl: null,
      previousImageMediaId: null,
      previousImageUrl: null,
      croppedImageMediaId: null,
      croppedImageUrl: null,
      upscaledImageMediaId: null,
      upscaledImageUrl: null,
      candidateImages: index === 0
        ? JSON.stringify(['legacy/untracked-candidate.png'])
        : null,
    })),
  }],
}

async function getStoryboardStage() {
  const { GET } = await import('@/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route')
  return GET(buildMockRequest({
    path: '/api/novel-promotion/project-1/episodes/episode-1/stage/storyboard',
    method: 'GET',
  }), { params: Promise.resolve({ projectId: 'project-1', episodeId: 'episode-1', stage: 'storyboard' }) })
}

describe('episode stage media batching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      project: { id: 'project-1', userId: 'user-1' },
    })
    prismaMock.novelPromotionEpisode.findFirst.mockResolvedValue(episode)
    prismaMock.mediaObject.findMany.mockResolvedValue(mediaRows)
    prismaMock.mediaObject.findUnique.mockImplementation(async ({ where }: { where: { id?: string; storageKey?: string } }) => {
      if (where.id) return mediaRows.find((row) => row.id === where.id) ?? null
      return mediaRows.find((row) => row.storageKey === where.storageKey) ?? null
    })
    prismaMock.mediaObject.upsert.mockImplementation(async ({ create }: { create: { publicId: string; storageKey: string } }) => (
      mediaRow('legacy-created', create.publicId, create.storageKey)
    ))
  })

  it('resolves many panels with a constant number of read queries and no GET-time writes', async () => {
    const response = await getStoryboardStage()
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(prismaMock.mediaObject.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.mediaObject.findMany).toHaveBeenCalledWith({
      where: {
        OR: expect.arrayContaining([
          { id: { in: expect.arrayContaining(['image-0', `image-${panelCount - 1}`]) } },
          { storageKey: { in: expect.arrayContaining(['legacy/untracked-candidate.png']) } },
        ]),
      },
    })
    expect(prismaMock.mediaObject.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.mediaObject.upsert).not.toHaveBeenCalled()
    expect(body.episode.storyboards[0].panels[0].imageUrl).toBe('/m/public-image-0')
    expect(body.episode.storyboards[0].panels[panelCount - 1].imageUrl).toBe(`/m/public-image-${panelCount - 1}`)
    expect(JSON.parse(body.episode.storyboards[0].panels[0].candidateImages)).toEqual([
      'legacy/untracked-candidate.png',
    ])
  })
})
