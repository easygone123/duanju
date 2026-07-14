import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '@/lib/query/keys'
import { applyWorkspaceTaskCompletion } from '@/lib/query/cache/task-event-patcher'

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function panel(id: string, imageUrl: string | null = null, videoUrl: string | null = null) {
  return { id, imageUrl, videoUrl, description: id }
}

function stage(stage: 'storyboard' | 'videos' | 'voice', panels: Array<Record<string, unknown>>) {
  return {
    stage,
    episode: {
      id: 'episode-1',
      name: 'Episode',
      episodeNumber: 1,
      clips: [],
      storyboards: [{ id: 'storyboard-1', panels }],
    },
  }
}

describe('workspace task completion cache patcher', () => {
  it('patches one panel across compatible stage and legacy caches without touching unrelated references', () => {
    const queryClient = client()
    const storyboardPanel = panel('panel-1', 'old.jpg')
    const storyboardSibling = panel('panel-2', 'sibling.jpg')
    const videoPanel = panel('panel-1', 'old.jpg', null)
    const videoSibling = panel('panel-2', 'sibling.jpg', 'sibling.mp4')
    const storyboardData = stage('storyboard', [storyboardPanel, storyboardSibling])
    const videosData = stage('videos', [videoPanel, videoSibling])
    const voiceData = stage('voice', [{ id: 'panel-1', description: 'voice projection' }])
    const legacyData = {
      id: 'episode-1',
      storyboards: [{ id: 'storyboard-1', panels: [storyboardPanel, storyboardSibling] }],
    }
    const projectData = { id: 'project-1', name: 'Project' }
    const assetData = { characters: [{ id: 'character-1' }] }

    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'), storyboardData)
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'videos'), videosData)
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'voice'), voiceData)
    queryClient.setQueryData(queryKeys.episodeData('project-1', 'episode-1'), legacyData)
    queryClient.setQueryData(queryKeys.projectData('project-1'), projectData)
    queryClient.setQueryData(queryKeys.projectAssets.all('project-1'), assetData)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'NovelPromotionPanel',
      targetId: 'panel-1',
      taskType: 'image_panel',
      payload: { panelId: 'panel-1', imageUrl: 'new.jpg' },
    })

    expect(result).toEqual({ handled: true, patched: true, stages: ['storyboard', 'videos'] })

    const nextStoryboard = queryClient.getQueryData<typeof storyboardData>(
      queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'),
    )!
    const nextVideos = queryClient.getQueryData<typeof videosData>(
      queryKeys.episodeStage('project-1', 'episode-1', 'videos'),
    )!
    const nextLegacy = queryClient.getQueryData<typeof legacyData>(
      queryKeys.episodeData('project-1', 'episode-1'),
    )!

    expect(nextStoryboard.episode.storyboards[0].panels[0].imageUrl).toBe('new.jpg')
    expect(nextVideos.episode.storyboards[0].panels[0].imageUrl).toBe('new.jpg')
    expect(nextLegacy.storyboards[0].panels[0].imageUrl).toBe('new.jpg')
    expect(nextStoryboard.episode.storyboards[0].panels[1]).toBe(storyboardSibling)
    expect(nextVideos.episode.storyboards[0].panels[1]).toBe(videoSibling)
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'voice'))).toBe(voiceData)
    expect(queryClient.getQueryData(queryKeys.projectData('project-1'))).toBe(projectData)
    expect(queryClient.getQueryData(queryKeys.projectAssets.all('project-1'))).toBe(assetData)
  })

  it('patches video output only into the videos and legacy episode caches', () => {
    const queryClient = client()
    const storyboardData = stage('storyboard', [panel('panel-1', 'image.jpg')])
    const videosData = stage('videos', [panel('panel-1', 'image.jpg')])
    const legacyData = { id: 'episode-1', storyboards: [{ id: 'storyboard-1', panels: [panel('panel-1')] }] }
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'), storyboardData)
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'videos'), videosData)
    queryClient.setQueryData(queryKeys.episodeData('project-1', 'episode-1'), legacyData)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionPanel',
      targetId: 'panel-1', taskType: 'video_panel', payload: { videoUrl: 'video.mp4' },
    })

    expect(result).toEqual({ handled: true, patched: true, stages: ['videos'] })
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'))).toBe(storyboardData)
    expect(queryClient.getQueryData<typeof videosData>(
      queryKeys.episodeStage('project-1', 'episode-1', 'videos'),
    )!.episode.storyboards[0].panels[0].videoUrl).toBe('video.mp4')
    expect(queryClient.getQueryData<typeof legacyData>(
      queryKeys.episodeData('project-1', 'episode-1'),
    )!.storyboards[0].panels[0].videoUrl).toBe('video.mp4')
  })

  it('leaves caches untouched when the completion payload cannot be decoded', () => {
    const queryClient = client()
    const videosData = stage('videos', [panel('panel-1')])
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'videos'), videosData)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionPanel',
      targetId: 'panel-1', taskType: 'video_panel', payload: {},
    })

    expect(result).toEqual({ handled: false, patched: false, stages: ['videos'] })
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'videos'))).toBe(videosData)
  })

  it('does not erase an existing image when a candidate completion reports a null imageUrl', () => {
    const queryClient = client()
    const storyboardData = stage('storyboard', [panel('panel-1', 'existing.jpg')])
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'), storyboardData)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionPanel',
      targetId: 'panel-1', taskType: 'image_panel', payload: { imageUrl: null, candidateCount: 4 },
    })

    expect(result).toEqual({ handled: false, patched: false, stages: ['storyboard', 'videos'] })
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'))).toBe(storyboardData)
  })

  it('is referentially stable when a replayed event contains the value already cached', () => {
    const queryClient = client()
    const storyboardData = stage('storyboard', [panel('panel-1', 'current.jpg')])
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'), storyboardData)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionPanel',
      targetId: 'panel-1', taskType: 'image_panel', payload: { imageUrl: 'current.jpg' },
    })

    expect(result).toEqual({ handled: true, patched: false, stages: ['storyboard', 'videos'] })
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'))).toBe(storyboardData)
  })

  it('requests recovery when an affected cached projection does not contain the target panel', () => {
    const queryClient = client()
    const staleStoryboard = stage('storyboard', [panel('panel-2', 'sibling.jpg')])
    queryClient.setQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'), staleStoryboard)

    const result = applyWorkspaceTaskCompletion(queryClient, {
      projectId: 'project-1', episodeId: 'episode-1', targetType: 'NovelPromotionPanel',
      targetId: 'panel-1', taskType: 'image_panel', payload: { imageUrl: 'new.jpg' },
    })

    expect(result).toEqual({ handled: false, patched: false, stages: ['storyboard', 'videos'] })
    expect(queryClient.getQueryData(queryKeys.episodeStage('project-1', 'episode-1', 'storyboard'))).toBe(staleStoryboard)
  })
})
