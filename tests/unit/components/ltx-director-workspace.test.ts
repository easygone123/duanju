import { describe, expect, it } from 'vitest'

import type {
  Storyboard,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  buildEpisodeDirectorStoryboard,
  moveTimelineSegment,
  withEpisodeAudio,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/LtxDirectorWorkspace'

describe('LTX Director workspace timeline', () => {
  it('builds one episode timeline anchor from every storyboard group', () => {
    const storyboards = [
      {
        id: 'storyboard-1',
        continuityAnchor: 'same office',
        panels: [{ id: 'panel-1' }],
      },
      {
        id: 'storyboard-2',
        continuityAnchor: 'same wardrobe',
        panels: [{ id: 'panel-2' }, { id: 'panel-3' }],
      },
    ] as unknown as Storyboard[]

    expect(buildEpisodeDirectorStoryboard(storyboards)).toMatchObject({
      id: 'storyboard-1',
      continuityAnchor: 'same office\nsame wardrobe',
      panels: [{ id: 'panel-1' }, { id: 'panel-2' }, { id: 'panel-3' }],
    })
  })

  it('inserts a text segment visibly instead of covering the existing main-track clip', () => {
    const segments = moveTimelineSegment([
      { id: 'image', type: 'image', prompt: 'image', startSeconds: 0, durationSeconds: 3 },
      { id: 'text', type: 'text', prompt: '', startSeconds: 0, durationSeconds: 2 },
    ], 'text', 0, 0, true)

    expect(segments).toEqual([
      expect.objectContaining({ id: 'text', startSeconds: 0, durationSeconds: 2 }),
      expect.objectContaining({ id: 'image', startSeconds: 2, durationSeconds: 3 }),
    ])
  })

  it('adds the episode source audio as one full Director audio track', () => {
    const result = withEpisodeAudio({
      version: 1,
      fps: 24,
      globalPrompt: 'keep the source story',
      segments: [
        { id: 'panel-1', type: 'image', prompt: 'first', startSeconds: 0, durationSeconds: 4 },
        { id: 'panel-2', type: 'image', prompt: 'second', startSeconds: 4, durationSeconds: 6 },
      ],
    }, {
      mediaId: 'audio-media-1',
      url: '/m/source-audio',
      mimeType: 'audio/mpeg',
      durationSeconds: 10,
    })

    expect(result).toMatchObject({
      audioTrackEnabled: true,
      useCustomAudio: true,
      overrideAudio: true,
      audioSegments: [{
        sourceMediaId: 'audio-media-1',
        sourceUrl: '/m/source-audio',
        startSeconds: 0,
        durationSeconds: 10,
      }],
    })
  })
})
