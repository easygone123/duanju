'use client'

import VoiceStage from './VoiceStage'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'
import StageDataBoundary from './StageDataBoundary'

export default function VoiceStageRoute() {
  const runtime = useWorkspaceStageRuntime()
  const { projectId, episodeId } = useWorkspaceProvider()
  const stageQuery = useWorkspaceEpisodeStageData('voice')

  if (!episodeId) return null
  if (stageQuery.data === undefined) {
    return <StageDataBoundary data={stageQuery.data} status={stageQuery.status} error={stageQuery.error} refetch={stageQuery.refetch}>{null}</StageDataBoundary>
  }

  return (
    <VoiceStage
      projectId={projectId}
      episodeId={episodeId}
      onBack={() => runtime.onStageChange('videos')}
      onOpenAssetLibraryForCharacter={(characterId) =>
        characterId
          ? runtime.onOpenAssetLibraryForCharacter(characterId, false)
          : runtime.onOpenAssetLibrary()
      }
    />
  )
}
