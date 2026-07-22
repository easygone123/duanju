import { describe, expect, it } from 'vitest'
import { createProjectFromPanels } from '@/features/video-editor/hooks/useEditorActions'

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
})
