'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import {
  WorkspaceStageCache,
  normalizeWorkspaceStage,
  scheduleNextWorkspaceStagePrefetch,
  type WorkspaceStageComponentMap,
} from './WorkspaceStageCache'

interface WorkspaceStageContentProps {
  currentStage: string
  episodeId?: string
}

export const workspaceStageLoaders = {
  config: () => import('./ConfigStage'),
  script: () => import('./ScriptStage'),
  storyboard: () => import('./StoryboardStage'),
  videos: () => import('./VideoStageRoute'),
  voice: () => import('./VoiceStageRoute'),
}

function WorkspaceStageLoadingFallback() {
  return <div className="min-h-[50vh]" aria-busy="true" />
}

const workspaceStageComponents: WorkspaceStageComponentMap = {
  config: dynamic(workspaceStageLoaders.config, { loading: WorkspaceStageLoadingFallback }),
  script: dynamic(workspaceStageLoaders.script, { loading: WorkspaceStageLoadingFallback }),
  storyboard: dynamic(workspaceStageLoaders.storyboard, { loading: WorkspaceStageLoadingFallback }),
  videos: dynamic(workspaceStageLoaders.videos, { loading: WorkspaceStageLoadingFallback }),
  voice: dynamic(workspaceStageLoaders.voice, { loading: WorkspaceStageLoadingFallback }),
}

export default function WorkspaceStageContent({
  currentStage,
  episodeId,
}: WorkspaceStageContentProps) {
  const activeStage = normalizeWorkspaceStage(currentStage)

  useEffect(() => (
    scheduleNextWorkspaceStagePrefetch(activeStage, workspaceStageLoaders)
  ), [activeStage])

  return (
    <WorkspaceStageCache
      currentStage={activeStage}
      episodeId={episodeId}
      stageComponents={workspaceStageComponents}
    />
  )
}
