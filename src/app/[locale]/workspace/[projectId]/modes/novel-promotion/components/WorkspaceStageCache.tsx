'use client'

import React, { useEffect, useState, type ComponentType } from 'react'
import { WorkspaceStageActivityProvider } from './WorkspaceStageActivityContext'

export const CANONICAL_WORKSPACE_STAGES = [
  'config',
  'script',
  'storyboard',
  'videos',
  'voice',
] as const

export const MAX_WORKSPACE_STAGE_SHELLS = 3

export type CanonicalWorkspaceStage = (typeof CANONICAL_WORKSPACE_STAGES)[number]
export type WorkspaceStageComponentMap = Record<CanonicalWorkspaceStage, ComponentType>
export type WorkspaceStageLoader = () => unknown
export type WorkspaceStageLoaderMap = Record<CanonicalWorkspaceStage, WorkspaceStageLoader>

export interface WorkspaceStageCacheState {
  scopeKey: string
  stages: CanonicalWorkspaceStage[]
}

export interface WorkspaceStagePrefetchScheduler {
  requestIdleCallback?: (callback: () => void) => number
  cancelIdleCallback?: (handle: number) => void
  setTimeout: (callback: () => void, delay: number) => unknown
  clearTimeout: (handle: unknown) => void
}

interface WorkspaceStageCacheProps {
  currentStage: string
  projectId?: string
  episodeId?: string
  stageComponents: WorkspaceStageComponentMap
}

const WORKSPACE_STAGE_ALIASES: Record<string, CanonicalWorkspaceStage> = {
  assets: 'script',
  editor: 'videos',
  'text-storyboard': 'storyboard',
}

export function normalizeWorkspaceStage(stage: string): CanonicalWorkspaceStage {
  if ((CANONICAL_WORKSPACE_STAGES as readonly string[]).includes(stage)) {
    return stage as CanonicalWorkspaceStage
  }

  return WORKSPACE_STAGE_ALIASES[stage] ?? 'config'
}

export function createWorkspaceStageCacheState(
  scopeKey: string,
  currentStage: string,
): WorkspaceStageCacheState {
  return {
    scopeKey,
    stages: [normalizeWorkspaceStage(currentStage)],
  }
}

export function updateWorkspaceStageCache(
  state: WorkspaceStageCacheState,
  scopeKey: string,
  currentStage: string,
): WorkspaceStageCacheState {
  const normalizedStage = normalizeWorkspaceStage(currentStage)

  if (state.scopeKey !== scopeKey) {
    return createWorkspaceStageCacheState(scopeKey, normalizedStage)
  }

  if (state.stages.at(-1) === normalizedStage) {
    return state
  }

  const stages = [
    ...state.stages.filter((stage) => stage !== normalizedStage),
    normalizedStage,
  ].slice(-MAX_WORKSPACE_STAGE_SHELLS)

  return { scopeKey, stages }
}

function getBrowserPrefetchScheduler(): WorkspaceStagePrefetchScheduler {
  return {
    requestIdleCallback: typeof window.requestIdleCallback === 'function'
      ? (callback) => window.requestIdleCallback(callback)
      : undefined,
    cancelIdleCallback: typeof window.cancelIdleCallback === 'function'
      ? (handle) => window.cancelIdleCallback(handle)
      : undefined,
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  }
}

export function scheduleNextWorkspaceStagePrefetch(
  currentStage: string,
  loaders: WorkspaceStageLoaderMap,
  scheduler: WorkspaceStagePrefetchScheduler = getBrowserPrefetchScheduler(),
): () => void {
  const normalizedStage = normalizeWorkspaceStage(currentStage)
  const currentIndex = CANONICAL_WORKSPACE_STAGES.indexOf(normalizedStage)
  const nextStage = CANONICAL_WORKSPACE_STAGES[currentIndex + 1]

  if (!nextStage) return () => undefined

  let disposed = false
  const prefetch = () => {
    if (disposed) return

    try {
      void Promise.resolve(loaders[nextStage]()).catch(() => undefined)
    } catch {
      // Rendering the stage can retry a chunk that failed to prefetch.
    }
  }

  if (scheduler.requestIdleCallback) {
    const handle = scheduler.requestIdleCallback(prefetch)
    return () => {
      disposed = true
      scheduler.cancelIdleCallback?.(handle)
    }
  }

  const handle = scheduler.setTimeout(prefetch, 1_000)
  return () => {
    disposed = true
    scheduler.clearTimeout(handle)
  }
}

export function WorkspaceStageCache({
  currentStage,
  projectId,
  episodeId,
  stageComponents,
}: WorkspaceStageCacheProps) {
  const activeStage = normalizeWorkspaceStage(currentStage)
  const scopeKey = `${projectId ?? ''}:${episodeId ?? ''}`
  const [cachedState, setCachedState] = useState(() => (
    createWorkspaceStageCacheState(scopeKey, activeStage)
  ))
  const renderedState = updateWorkspaceStageCache(cachedState, scopeKey, activeStage)

  useEffect(() => {
    if (renderedState !== cachedState) setCachedState(renderedState)
  }, [cachedState, renderedState])

  return renderedState.stages.map((stage) => {
    const Stage = stageComponents[stage]
    const isActive = stage === activeStage

    return (
      <div
        key={`${renderedState.scopeKey}:${stage}`}
        data-workspace-stage-shell={stage}
        className="animate-page-enter"
        hidden={!isActive}
        aria-hidden={!isActive}
      >
        <WorkspaceStageActivityProvider isActive={isActive}>
          <Stage />
        </WorkspaceStageActivityProvider>
      </div>
    )
  })
}
