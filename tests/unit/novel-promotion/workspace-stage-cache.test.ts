// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import WorkspaceStageContent from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageContent'
import {
  MAX_WORKSPACE_STAGE_SHELLS,
  WorkspaceStageCache,
  createWorkspaceStageCacheState,
  normalizeWorkspaceStage,
  scheduleNextWorkspaceStagePrefetch,
  updateWorkspaceStageCache,
  type WorkspaceStageComponentMap,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageCache'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const stageModules = vi.hoisted(() => ({
  loads: {
    config: 0,
    script: 0,
    storyboard: 0,
    videos: 0,
    voice: 0,
  },
}))

function stageModule(stage: keyof typeof stageModules.loads) {
  stageModules.loads[stage] += 1

  return {
    default: function TestStage() {
      return React.createElement('label', null,
        `${stage} state`,
        React.createElement('input', { 'aria-label': `${stage} state`, defaultValue: '' }),
      )
    },
  }
}

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage', () => stageModule('config'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ScriptStage', () => stageModule('script'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage', () => stageModule('storyboard'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VideoStageRoute', () => stageModule('videos'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VoiceStageRoute', () => stageModule('voice'))

beforeEach(() => {
  for (const stage of Object.keys(stageModules.loads) as Array<keyof typeof stageModules.loads>) {
    stageModules.loads[stage] = 0
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkspaceStageContent dynamic boundaries', () => {
  it('loads only the active stage module on a cold render', async () => {
    render(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))

    await waitFor(() => expect(stageModules.loads.config).toBe(1))
    expect(stageModules.loads).toEqual({
      config: 1,
      script: 0,
      storyboard: 0,
      videos: 0,
      voice: 0,
    })
  })

  it('keeps a recently visited stage mounted when switching away and back', async () => {
    const view = render(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))
    const configInput = await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement
    fireEvent.change(configInput, { target: { value: 'local draft' } })

    view.rerender(React.createElement(WorkspaceStageContent, {
      currentStage: 'script',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))
    await view.findByRole('textbox', { name: 'script state' })

    view.rerender(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))

    expect((await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement).value)
      .toBe('local draft')
  })

  it('remounts the current stage when the episode changes', async () => {
    const view = render(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))
    const configInput = await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement
    fireEvent.change(configInput, { target: { value: 'episode one draft' } })

    view.rerender(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-2',
    }))

    expect((await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement).value)
      .toBe('')
  })

  it('remounts the current stage when the project changes', async () => {
    const ProjectScopedStageContent = WorkspaceStageContent as React.ComponentType<{
      currentStage: string
      projectId: string
      episodeId?: string
    }>
    const view = render(React.createElement(ProjectScopedStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
    }))
    const configInput = await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement
    fireEvent.change(configInput, { target: { value: 'project one draft' } })

    view.rerender(React.createElement(ProjectScopedStageContent, {
      currentStage: 'config',
      projectId: 'project-2',
    }))

    expect((await view.findByRole('textbox', { name: 'config state' }) as HTMLInputElement).value)
      .toBe('')
  })
})

describe('WorkspaceStageCache', () => {
  const stage = (name: string) => {
    function TestCachedStage() {
      return React.createElement('div', { 'data-testid': `${name}-content` }, name)
    }

    return TestCachedStage
  }
  const stageComponents: WorkspaceStageComponentMap = {
    config: stage('config'),
    script: stage('script'),
    storyboard: stage('storyboard'),
    videos: stage('videos'),
    voice: stage('voice'),
  }

  it('normalizes legacy URL aliases to canonical stages', () => {
    expect(normalizeWorkspaceStage('assets')).toBe('script')
    expect(normalizeWorkspaceStage('editor')).toBe('videos')
    expect(normalizeWorkspaceStage('text-storyboard')).toBe('storyboard')
    expect(normalizeWorkspaceStage('voice')).toBe('voice')
  })

  it('keeps the current shell plus the two most recently visited shells', () => {
    let state = createWorkspaceStageCacheState('episode-1', 'config')
    state = updateWorkspaceStageCache(state, 'episode-1', 'script')
    state = updateWorkspaceStageCache(state, 'episode-1', 'storyboard')
    state = updateWorkspaceStageCache(state, 'episode-1', 'config')

    expect(state.stages).toEqual(['script', 'storyboard', 'config'])
    expect(state.stages).toHaveLength(MAX_WORKSPACE_STAGE_SHELLS)
  })

  it('evicts the least recently visited non-current shell on the fourth stage', () => {
    let state = createWorkspaceStageCacheState('episode-1', 'config')
    state = updateWorkspaceStageCache(state, 'episode-1', 'script')
    state = updateWorkspaceStageCache(state, 'episode-1', 'storyboard')
    state = updateWorkspaceStageCache(state, 'episode-1', 'videos')

    expect(state.stages).toEqual(['script', 'storyboard', 'videos'])
  })

  it('renders no more than three shells and exposes exactly one', () => {
    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents,
    }))

    for (const currentStage of ['script', 'storyboard', 'videos']) {
      view.rerender(React.createElement(WorkspaceStageCache, {
        currentStage,
        episodeId: 'episode-1',
        stageComponents,
      }))
    }

    const shells = [...view.container.querySelectorAll('[data-workspace-stage-shell]')]
    expect(shells).toHaveLength(3)
    expect(shells.filter((shell) => !shell.hasAttribute('hidden'))).toHaveLength(1)
    expect(shells.filter((shell) => shell.getAttribute('aria-hidden') === 'true')).toHaveLength(2)
    expect(view.getByTestId('videos-content').closest('[data-workspace-stage-shell]')?.hasAttribute('hidden'))
      .toBe(false)
  })

  it('resets visited shells when the episode changes', () => {
    const populated = updateWorkspaceStageCache(
      createWorkspaceStageCacheState('episode-1', 'config'),
      'episode-1',
      'script',
    )

    expect(updateWorkspaceStageCache(populated, 'episode-2', 'storyboard')).toEqual({
      scopeKey: 'episode-2',
      stages: ['storyboard'],
    })
  })

  it('prefetches only the next stage loader during idle time and cleans up', async () => {
    const loaders = {
      config: vi.fn(),
      script: vi.fn().mockResolvedValue({}),
      storyboard: vi.fn(),
      videos: vi.fn(),
      voice: vi.fn(),
    }
    const idleCallbacks = new Map<number, () => void>()
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallbacks.set(7, callback)
      return 7
    })
    const cancelIdleCallback = vi.fn((id: number) => idleCallbacks.delete(id))

    const cleanupPrefetch = scheduleNextWorkspaceStagePrefetch('config', loaders, {
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    })

    expect(loaders.script).not.toHaveBeenCalled()
    idleCallbacks.get(7)?.()
    await Promise.resolve()
    expect(loaders.script).toHaveBeenCalledOnce()
    expect(loaders.storyboard).not.toHaveBeenCalled()

    cleanupPrefetch()
    expect(cancelIdleCallback).toHaveBeenCalledWith(7)
  })

  it('uses a cancellable timeout when requestIdleCallback is unavailable', () => {
    const loaders = {
      config: vi.fn(),
      script: vi.fn(),
      storyboard: vi.fn(),
      videos: vi.fn(),
      voice: vi.fn(),
    }
    const setTimeout = vi.fn((callback: () => void, delay: number) => {
      void callback
      void delay
      return 11
    })
    const clearTimeout = vi.fn()

    const cleanupPrefetch = scheduleNextWorkspaceStagePrefetch('script', loaders, {
      setTimeout,
      clearTimeout,
    })
    const scheduledCallback = setTimeout.mock.calls[0]?.[0] as (() => void) | undefined
    scheduledCallback?.()
    expect(loaders.storyboard).toHaveBeenCalledOnce()

    cleanupPrefetch()
    expect(clearTimeout).toHaveBeenCalledWith(11)
  })

  it('does not run a stale idle callback after cleanup', () => {
    const loaders = {
      config: vi.fn(),
      script: vi.fn(),
      storyboard: vi.fn(),
      videos: vi.fn(),
      voice: vi.fn(),
    }
    let idleCallback: (() => void) | undefined
    const cleanupPrefetch = scheduleNextWorkspaceStagePrefetch('config', loaders, {
      requestIdleCallback: (callback) => {
        idleCallback = callback
        return 19
      },
      cancelIdleCallback: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    })

    cleanupPrefetch()
    idleCallback?.()

    expect(loaders.script).not.toHaveBeenCalled()
  })

  it('contains a rejected prefetch loader', async () => {
    const loaders = {
      config: vi.fn(),
      script: vi.fn().mockRejectedValue(new Error('prefetch unavailable')),
      storyboard: vi.fn(),
      videos: vi.fn(),
      voice: vi.fn(),
    }
    let idleCallback: (() => void) | undefined
    scheduleNextWorkspaceStagePrefetch('config', loaders, {
      requestIdleCallback: (callback) => {
        idleCallback = callback
        return 23
      },
      cancelIdleCallback: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    })

    idleCallback?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(loaders.script).toHaveBeenCalledOnce()
  })

  it('does not schedule prefetch after the final voice stage', () => {
    const loaders = {
      config: vi.fn(),
      script: vi.fn(),
      storyboard: vi.fn(),
      videos: vi.fn(),
      voice: vi.fn(),
    }
    const requestIdleCallback = vi.fn()
    const setTimeout = vi.fn()

    scheduleNextWorkspaceStagePrefetch('voice', loaders, {
      requestIdleCallback,
      cancelIdleCallback: vi.fn(),
      setTimeout,
      clearTimeout: vi.fn(),
    })

    expect(requestIdleCallback).not.toHaveBeenCalled()
    expect(setTimeout).not.toHaveBeenCalled()
  })
})
