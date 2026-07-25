import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveMediaRefMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/media/service', () => ({
  createReadOnlyMediaResolver: vi.fn(async () => ({
    resolve: resolveMediaRefMock,
    resolveLegacy: vi.fn(async () => null),
  })),
  resolveMediaRef: resolveMediaRefMock,
  resolveMediaRefFromLegacyValue: vi.fn(async () => null),
}))

import { attachMediaFieldsToProject } from '@/lib/media/attach'

describe('voice-line media attachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveMediaRefMock.mockResolvedValue({
      id: 'media-new',
      publicId: 'public-new',
      url: '/m/public-new',
    })
  })

  it('resolves the newly persisted audioMediaId instead of a replaced legacy audio object', async () => {
    const project = await attachMediaFieldsToProject({
      audioMediaId: null,
      audioUrl: null,
      voiceLines: [{
        id: 'line-1',
        audioMediaId: 'media-new',
        audioUrl: 'voice/new.wav',
      }],
    })

    expect(resolveMediaRefMock).toHaveBeenCalledWith('media-new', 'voice/new.wav')
    expect(project.voiceLines).toEqual([
      expect.objectContaining({
        audioMediaId: 'media-new',
        audioUrl: '/m/public-new',
      }),
    ])
  })

  it('treats legacy nullable appearance image arrays as empty read payloads', async () => {
    const project = await attachMediaFieldsToProject({
      characters: [{
        id: 'character-1',
        appearances: [{
          id: 'appearance-1',
          imageUrls: null,
          previousImageUrls: null,
        }],
      }],
    })

    const character = (project.characters as Array<Record<string, unknown>>)[0]
    const appearance = (character.appearances as Array<Record<string, unknown>>)[0]
    expect(appearance.imageUrls).toEqual([])
    expect(appearance.previousImageUrls).toEqual([])
  })
})
