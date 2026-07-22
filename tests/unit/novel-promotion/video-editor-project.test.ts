import { describe, expect, it } from 'vitest'
import {
  createProjectFromPanels,
  refreshEditorProjectMedia,
} from '@/features/video-editor/hooks/useEditorActions'

describe('createProjectFromPanels', () => {
  it('imports generated videos and binds voice lines by panel identity', () => {
    const project = createProjectFromPanels('episode-1', [
      {
        id: 'panel-1',
        storyboardId: 'storyboard-1',
        panelIndex: 0,
        videoUrl: '/m/video-1',
        duration: 2,
        description: 'first shot',
      },
      {
        id: 'panel-2',
        storyboardId: 'storyboard-1',
        panelIndex: 1,
        videoUrl: '/m/video-2',
        duration: 4.5,
        hasEmbeddedDialogueAudio: true,
      },
      {
        id: 'panel-without-video',
        storyboardId: 'storyboard-1',
        panelIndex: 2,
      },
    ], [
      {
        id: 'voice-panel-2-dialogue',
        speaker: 'B',
        content: 'second dialogue',
        audioUrl: '/m/dialogue-2',
        lineType: 'dialogue',
        matchedPanelId: 'panel-2',
      },
      {
        id: 'voice-panel-1',
        speaker: 'A',
        content: 'first dialogue',
        audioUrl: '/m/dialogue-1',
        lineType: 'dialogue',
        matchedPanelId: 'panel-1',
      },
      {
        id: 'voice-panel-2-narration',
        speaker: 'Narrator',
        content: 'second narration',
        audioUrl: '/m/narration-2',
        lineType: 'narration',
        matchedStoryboardId: 'storyboard-1',
        matchedPanelIndex: 1,
      },
    ])

    expect(project.timeline).toHaveLength(2)
    expect(project.timeline[0]).toMatchObject({
      src: '/m/video-1',
      durationInFrames: 60,
      attachment: {
        audio: { src: '/m/dialogue-1', voiceLineId: 'voice-panel-1' },
        subtitle: { text: 'first dialogue' },
      },
      metadata: { panelId: 'panel-1', description: 'first shot' },
    })
    expect(project.timeline[1]).toMatchObject({
      src: '/m/video-2',
      durationInFrames: 135,
      attachment: {
        audio: { src: '/m/narration-2', voiceLineId: 'voice-panel-2-narration' },
        subtitle: { text: 'second dialogue\nsecond narration' },
      },
      metadata: { panelId: 'panel-2' },
    })
  })

  it('refreshes expired saved media URLs without losing edit decisions', () => {
    const source = createProjectFromPanels('episode-1', [{
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      videoUrl: '/m/current-video',
      duration: 4,
    }], [{
      id: 'voice-1',
      speaker: 'A',
      content: 'current subtitle',
      audioUrl: '/m/current-audio',
      matchedPanelId: 'panel-1',
    }])
    const saved = {
      ...source,
      autoCut: {
        status: 'completed' as const,
        completedAt: '2026-07-22T00:00:00.000Z',
        summary: 'saved plan',
        sourceClipCount: 1,
        outputClipCount: 1,
        durationInFrames: 60,
      },
      timeline: [{
        ...source.timeline[0],
        src: 'https://expired.example/video.mp4',
        durationInFrames: 60,
        trim: { from: 15, to: 75 },
        attachment: {
          audio: {
            ...source.timeline[0].attachment!.audio!,
            src: 'https://expired.example/audio.mp3',
            volume: 0.6,
          },
          subtitle: { text: 'old subtitle', style: 'cinematic' as const },
        },
        transition: { type: 'fade' as const, durationInFrames: 10 },
      }],
    }

    const refreshed = refreshEditorProjectMedia(saved, source)

    expect(refreshed.timeline[0]).toMatchObject({
      src: '/m/current-video',
      durationInFrames: 60,
      trim: { from: 15, to: 75 },
      transition: { type: 'fade', durationInFrames: 10 },
      attachment: {
        audio: { src: '/m/current-audio', volume: 0.6 },
        subtitle: { text: 'current subtitle', style: 'cinematic' },
      },
    })
    expect(refreshed.autoCut?.summary).toBe('saved plan')
  })

  it('recognizes a previously saved auto-cut timeline from clip metadata', () => {
    const source = createProjectFromPanels('episode-1', [{
      id: 'panel-1',
      storyboardId: 'storyboard-1',
      videoUrl: '/m/current-video',
    }])
    const saved = {
      ...source,
      timeline: source.timeline.map((clip) => ({
        ...clip,
        metadata: { ...clip.metadata, autoCutReason: '保留剧情落点' },
      })),
    }

    const refreshed = refreshEditorProjectMedia(saved, source)

    expect(refreshed.autoCut).toMatchObject({
      status: 'completed',
      sourceClipCount: 1,
      outputClipCount: 1,
      durationInFrames: 90,
    })
  })
})
