'use client'

import dynamic, { type DynamicOptionsLoadingProps, type Loader } from 'next/dynamic'
import { useEffect } from 'react'
import {
  WorkspaceStageCache,
  normalizeWorkspaceStage,
  scheduleNextWorkspaceStagePrefetch,
  type WorkspaceStageComponentMap,
  type WorkspaceStageLoaderMap,
} from './WorkspaceStageCache'

interface WorkspaceStageContentProps {
  currentStage: string
  projectId: string
  episodeId?: string
}

export const workspaceStageLoaders = {
  config: () => import('./ConfigStage'),
  script: () => import('./ScriptStage'),
  storyboard: () => import('./StoryboardStage'),
  videos: () => import('./VideoStageRoute'),
  voice: () => import('./VoiceStageRoute'),
  editor: () => import('./EditorStageRoute'),
}

export function WorkspaceStageLoadingFallback({
  error,
  retry,
}: DynamicOptionsLoadingProps) {
  if (error) {
    return (
      <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3" role="alert">
        <p>Workspace stage failed to load.</p>
        <button
          type="button"
          className="glass-btn-base glass-btn-secondary px-4 py-2"
          onClick={retry}
          disabled={!retry}
          aria-label="Retry loading workspace stage"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div
      className="min-h-[50vh]"
      role="status"
      aria-label="Loading workspace stage"
      aria-busy="true"
    />
  )
}

export function createWorkspaceStageComponents(
  loaders: WorkspaceStageLoaderMap,
): WorkspaceStageComponentMap {
  return {
    config: dynamic(loaders.config as Loader, { loading: WorkspaceStageLoadingFallback }),
    script: dynamic(loaders.script as Loader, { loading: WorkspaceStageLoadingFallback }),
    storyboard: dynamic(loaders.storyboard as Loader, { loading: WorkspaceStageLoadingFallback }),
    videos: dynamic(loaders.videos as Loader, { loading: WorkspaceStageLoadingFallback }),
    voice: dynamic(loaders.voice as Loader, { loading: WorkspaceStageLoadingFallback }),
    editor: dynamic(loaders.editor as Loader, { loading: WorkspaceStageLoadingFallback }),
  }
}

const workspaceStageComponents = createWorkspaceStageComponents(workspaceStageLoaders)

export default function WorkspaceStageContent({
  currentStage,
  projectId,
  episodeId,
}: WorkspaceStageContentProps) {
  const activeStage = normalizeWorkspaceStage(currentStage)

  useEffect(() => (
    scheduleNextWorkspaceStagePrefetch(activeStage, workspaceStageLoaders)
  ), [activeStage])

  return (
    <WorkspaceStageCache
      currentStage={activeStage}
      projectId={projectId}
      episodeId={episodeId}
      stageComponents={workspaceStageComponents}
    />
  )
}
