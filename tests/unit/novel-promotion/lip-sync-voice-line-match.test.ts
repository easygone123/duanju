import { describe, expect, it } from 'vitest'
import {
  buildLipSyncPanelPublishVoiceLineWhere,
  buildLipSyncVoiceLinePanelMatch,
  buildOwnedLipSyncVoiceLineWhere,
} from '@/lib/novel-promotion/lip-sync/voice-line-match'

const panel = { id: 'panel-1', storyboardId: 'storyboard-1', panelIndex: 2 }

describe('lip-sync voice-line matching', () => {
  it('supports current panel ids and only the legacy dialogue storyboard/index fallback', () => {
    expect(buildLipSyncVoiceLinePanelMatch(panel)).toEqual({
      OR: [
        { matchedPanelId: 'panel-1' },
        {
          lineType: 'dialogue',
          matchedPanelId: null,
          matchedStoryboardId: 'storyboard-1',
          matchedPanelIndex: 2,
        },
      ],
    })
  })

  it('binds the legacy-compatible match to episode, project, and user ownership', () => {
    expect(buildOwnedLipSyncVoiceLineWhere({
      voiceLineId: 'line-1',
      panel,
      projectId: 'project-1',
      userId: 'user-1',
      episodeId: 'episode-1',
    })).toEqual(expect.objectContaining({
      id: 'line-1',
      enabled: true,
      episodeId: 'episode-1',
      episode: {
        storyboards: { some: { id: 'storyboard-1' } },
        novelPromotionProject: {
          projectId: 'project-1',
          project: { userId: 'user-1' },
        },
      },
    }))
  })

  it('builds one panel relation filter for the final voice-line snapshot CAS', () => {
    expect(buildLipSyncPanelPublishVoiceLineWhere({
      voiceLineId: 'line-1',
      panel,
      projectId: 'project-1',
      userId: 'user-1',
      lineType: 'narration',
      audioUrl: 'cos/line-1.mp3',
    })).toEqual({
      storyboard: {
        episode: {
          novelPromotionProject: {
            projectId: 'project-1',
            project: { userId: 'user-1' },
          },
          voiceLines: {
            some: {
              id: 'line-1',
              enabled: true,
              lineType: 'narration',
              audioUrl: 'cos/line-1.mp3',
              OR: [
                { matchedPanelId: 'panel-1' },
                {
                  lineType: 'dialogue',
                  matchedPanelId: null,
                  matchedStoryboardId: 'storyboard-1',
                  matchedPanelIndex: 2,
                },
              ],
            },
          },
        },
      },
    })
  })
})
