'use client'

import ScriptView from './ScriptView'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import StageDataBoundary from './StageDataBoundary'

export default function ScriptStage() {
  const runtime = useWorkspaceStageRuntime()
  const { projectId, episodeId } = useWorkspaceProvider()
  const stageQuery = useWorkspaceEpisodeStageData('script')
  const { clips } = stageQuery

  if (stageQuery.data === undefined) {
    return <StageDataBoundary data={stageQuery.data} status={stageQuery.status} error={stageQuery.error} refetch={stageQuery.refetch}>{null}</StageDataBoundary>
  }

  return (
    <ScriptView
      projectId={projectId}
      episodeId={episodeId}
      clips={clips}
      assetsLoading={runtime.assetsLoading}
      onClipUpdate={runtime.onClipUpdate}
      onOpenAssetLibrary={runtime.onOpenAssetLibrary}
      onGenerateStoryboard={runtime.onRunScriptToStoryboard}
      isSubmittingStoryboardBuild={runtime.isConfirmingAssets || runtime.isStartingScriptToStoryboard}
    />
  )
}
