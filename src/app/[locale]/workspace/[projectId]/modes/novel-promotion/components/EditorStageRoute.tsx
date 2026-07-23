'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMatchedVoiceLines } from '@/lib/query/hooks/useVoiceLines'
import type { VideoEpisodeStageStoryboard } from '@/lib/novel-promotion/episode-stage-data'
import {
  VideoEditorStage,
  createProjectFromPanels,
  refreshEditorProjectMedia,
  useEditorActions,
  type VideoEditorProject,
} from '@/features/video-editor'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'
import StageDataBoundary from './StageDataBoundary'

function buildEditorPanelDescription(panel: VideoEpisodeStageStoryboard['panels'][number]) {
  const fields = [
    panel.description,
    panel.shotType ? `景别：${panel.shotType}` : null,
    panel.cameraMove ? `运镜：${panel.cameraMove}` : null,
    panel.videoPrompt ? `视频提示词：${panel.videoPrompt}` : null,
    panel.dialogueText ? `对白：${panel.dialogueText}` : null,
    panel.srtSegment ? `剧情片段：${panel.srtSegment}` : null,
  ]
  return Array.from(new Set(fields.map((field) => field?.trim()).filter(Boolean))).join('\n')
}

export default function EditorStageRoute() {
  const runtime = useWorkspaceStageRuntime()
  const { projectId, episodeId } = useWorkspaceProvider()
  const stageQuery = useWorkspaceEpisodeStageData('videos')
  const voiceLinesQuery = useMatchedVoiceLines(projectId, episodeId || null)
  const { loadProject } = useEditorActions({ projectId, episodeId: episodeId || '' })
  const [initialProject, setInitialProject] = useState<VideoEditorProject | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const sourceProject = useMemo(() => {
    if (!episodeId) return null
    const videoEpisode = stageQuery.data?.stage === 'videos'
      ? stageQuery.data.episode
      : null

    const storyboards = [...(stageQuery.storyboards as unknown as VideoEpisodeStageStoryboard[])]
      .sort((left, right) => {
        const sequenceDiff = (left.groupSequence ?? Number.MAX_SAFE_INTEGER)
          - (right.groupSequence ?? Number.MAX_SAFE_INTEGER)
        if (sequenceDiff !== 0) return sequenceDiff
        return left.createdAt.localeCompare(right.createdAt)
      })

    const panels = storyboards.flatMap((storyboard) => (
      [...storyboard.panels]
        .sort((left, right) => left.panelIndex - right.panelIndex)
        .map((panel) => ({
          id: panel.id,
          panelIndex: panel.panelIndex,
          storyboardId: storyboard.id,
          videoUrl: panel.lipSyncVideoUrl || panel.videoUrl || undefined,
          description: buildEditorPanelDescription(panel) || undefined,
          duration: panel.durationOverride
            ?? panel.estimatedDuration
            ?? panel.duration
            ?? undefined,
          hasEmbeddedDialogueAudio: !!panel.lipSyncVideoUrl,
          subtitleText: panel.srtSegment || undefined,
        }))
    ))

    const voiceLines = (voiceLinesQuery.data?.voiceLines || []).map((voiceLine) => ({
      ...voiceLine,
      matchedPanelId: (voiceLine as typeof voiceLine & { matchedPanelId?: string | null }).matchedPanelId,
    }))

    return createProjectFromPanels(episodeId, panels, voiceLines, {
      originalAudioUrl: videoEpisode?.audioUrl,
      originalAudioDurationSeconds: videoEpisode?.audioMedia?.durationMs
        ? videoEpisode.audioMedia.durationMs / 1_000
        : videoEpisode?.clips.reduce(
            (total, clip) => total + (clip.duration || 0),
            0,
          ),
    })
  }, [episodeId, stageQuery.data, stageQuery.storyboards, voiceLinesQuery.data?.voiceLines])

  useEffect(() => {
    if (!episodeId || !sourceProject || stageQuery.data === undefined || voiceLinesQuery.isLoading) return

    let canceled = false
    setLoadError(null)
    void loadProject()
      .then((savedProject) => {
        if (!canceled) {
          setInitialProject(savedProject
            ? refreshEditorProjectMedia(savedProject, sourceProject)
            : sourceProject)
        }
      })
      .catch((error: unknown) => {
        if (canceled) return
        setLoadError(error instanceof Error ? error.message : String(error))
        setInitialProject(sourceProject)
      })

    return () => {
      canceled = true
    }
  }, [episodeId, loadProject, sourceProject, stageQuery.data, voiceLinesQuery.isLoading])

  if (!episodeId) return null
  if (stageQuery.data === undefined) {
    return (
      <StageDataBoundary
        data={stageQuery.data}
        status={stageQuery.status}
        error={stageQuery.error}
        refetch={stageQuery.refetch}
      >
        {null}
      </StageDataBoundary>
    )
  }

  if (!initialProject || !sourceProject) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-[var(--glass-text-secondary)]">
        正在载入全部分镜视频…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {loadError && (
        <div className="glass-surface px-4 py-3 text-sm text-[var(--glass-tone-warning-fg)]">
          已使用最新分镜重新建立剪辑工程；旧工程读取失败：{loadError}
        </div>
      )}
      <VideoEditorStage
        key={`${episodeId}:${initialProject.id}`}
        projectId={projectId}
        episodeId={episodeId}
        initialProject={initialProject}
        sourceProject={sourceProject}
        onBack={() => runtime.onStageChange('videos')}
      />
    </div>
  )
}
