import { describe, expect, it } from 'vitest'
import {
  hasScriptArtifacts,
  hasStoryboardArtifacts,
  hasVideoArtifacts,
  resolveEpisodeStageArtifacts,
} from '@/lib/novel-promotion/stage-readiness'

describe('stage readiness', () => {
  it('treats script as ready only when at least one clip has non-empty screenplay', () => {
    expect(hasScriptArtifacts([])).toBe(false)
    expect(hasScriptArtifacts([
      { id: 'clip-1', summary: '', location: null, characters: null, props: null, content: 'a', screenplay: '' },
    ])).toBe(false)
    expect(hasScriptArtifacts([
      { id: 'clip-1', summary: '', location: null, characters: null, props: null, content: 'a', screenplay: '  {"scenes":[]}' },
    ])).toBe(true)
  })

  it('treats storyboard as ready only when at least one storyboard has panels', () => {
    expect(hasStoryboardArtifacts([])).toBe(false)
    expect(hasStoryboardArtifacts([{ panels: [] }])).toBe(false)
    expect(hasStoryboardArtifacts([{ panels: [{ id: 'panel-1' }] }])).toBe(true)
  })

  it('treats video as ready only when at least one panel has videoUrl', () => {
    expect(hasVideoArtifacts([{ panels: [{ id: 'panel-1', videoUrl: '' }] }])).toBe(false)
    expect(hasVideoArtifacts([{ panels: [{ id: 'panel-1', videoUrl: 'https://example.com/video.mp4' }] }])).toBe(true)
  })

  it('derives full episode stage artifacts from persisted outputs', () => {
    const readiness = resolveEpisodeStageArtifacts({
      novelText: 'story',
      clips: [
        { id: 'clip-1', summary: '', location: null, characters: null, props: null, content: 'a', screenplay: '{"scenes":[]}' },
      ],
      storyboards: [
        {
          id: 'sb-1',
          episodeId: 'ep-1',
          clipId: 'clip-1',
          storyboardTextJson: null,
          panelCount: 1,
          storyboardImageUrl: null,
          panels: [{
            id: 'panel-1',
            storyboardId: 'sb-1',
            panelIndex: 0,
            panelNumber: 1,
            shotType: null,
            cameraMove: null,
            description: null,
            location: null,
            characters: null,
            props: null,
            srtSegment: null,
            srtStart: null,
            srtEnd: null,
            duration: null,
            imagePrompt: null,
            imageUrl: null,
            imageHistory: null,
            videoPrompt: null,
            videoUrl: 'https://example.com/video.mp4',
            photographyRules: null,
            actingNotes: null,
          }],
        },
      ],
      voiceLines: [{ id: 'voice-1' }],
    })

    expect(readiness).toEqual({
      hasStory: true,
      hasScript: true,
      hasStoryboard: true,
      hasVideo: true,
      hasVoice: true,
    })
  })

  it('does not treat disabled narration as a voice artifact', () => {
    expect(resolveEpisodeStageArtifacts({
      voiceLines: [{ id: 'narration-1', enabled: false }],
    })).toMatchObject({ hasVoice: false })
    expect(resolveEpisodeStageArtifacts({
      voiceLines: [
        { id: 'narration-1', enabled: false },
        { id: 'dialogue-1', enabled: true },
      ],
    })).toMatchObject({ hasVoice: true })
  })
})
