import { describe, expect, it } from 'vitest'

import type {
  Storyboard,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  buildEpisodeDirectorStoryboard,
  moveTimelineSegment,
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
})
