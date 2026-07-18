'use client'

import StoryboardStageView from './storyboard'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import StageDataBoundary from './StageDataBoundary'
import StoryboardModeSummary from './StoryboardModeSummary'

export default function StoryboardStage() {
  const runtime = useWorkspaceStageRuntime()
  const { projectId, episodeId } = useWorkspaceProvider()
  const stageQuery = useWorkspaceEpisodeStageData('storyboard')
  const { clips, storyboards } = stageQuery

  if (!episodeId) return null
  if (stageQuery.data === undefined) {
    return <StageDataBoundary data={stageQuery.data} status={stageQuery.status} error={stageQuery.error} refetch={stageQuery.refetch}>{null}</StageDataBoundary>
  }

  return <>
    <StoryboardModeSummary
      mode={runtime.storyboardGenerationMode}
      cellRatio={runtime.sixGridCellAspectRatio}
      videoRatio={runtime.videoRatio}
      onOpenSettings={() => runtime.onStageChange('config')}
    />
    <StoryboardStageView
        projectId={projectId}
        episodeId={episodeId}
        storyboards={storyboards}
        clips={clips}
        videoRatio={runtime.videoRatio || '9:16'}
        onBack={() => runtime.onStageChange('script')}
        onNext={async () => runtime.onStageChange('videos')}
        isTransitioning={runtime.isTransitioning}
      />
  </>
}
