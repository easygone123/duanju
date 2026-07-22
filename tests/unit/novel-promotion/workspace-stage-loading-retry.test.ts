// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createWorkspaceStageComponents,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageContent'
import {
  WorkspaceStageCache,
  type WorkspaceStageLoaderMap,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageCache'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

describe('workspace stage dynamic loading recovery', () => {
  it('shows an accessible error and retries a rejected stage loader successfully', async () => {
    const LoadedStage = () => React.createElement('div', null, 'recovered config stage')
    const configLoader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue({ default: LoadedStage })
    const idleLoader = vi.fn().mockResolvedValue({ default: LoadedStage })
    const loaders: WorkspaceStageLoaderMap = {
      config: configLoader,
      script: idleLoader,
      storyboard: idleLoader,
      videos: idleLoader,
      voice: idleLoader,
      editor: idleLoader,
    }

    const view = render(React.createElement(WorkspaceStageCache, {
      currentStage: 'config',
      episodeId: 'episode-1',
      stageComponents: createWorkspaceStageComponents(loaders),
    }))

    const error = await view.findByRole('alert')
    expect(error.textContent).toContain('Workspace stage failed to load')
    expect(error.hasAttribute('aria-busy')).toBe(false)

    fireEvent.click(view.getByRole('button', { name: 'Retry loading workspace stage' }))

    expect(await view.findByText('recovered config stage')).toBeTruthy()
    expect(configLoader).toHaveBeenCalledTimes(2)
  })
})
