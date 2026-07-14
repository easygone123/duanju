// @vitest-environment jsdom

import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import WorkspaceStageContent from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/WorkspaceStageContent'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const coldLoads = vi.hoisted(() => ({
  config: 0,
  script: 0,
  storyboard: 0,
  videos: 0,
  voice: 0,
}))

function coldStageModule(stage: keyof typeof coldLoads) {
  coldLoads[stage] += 1
  return {
    default: function ColdStage() {
      return React.createElement('div', null, `${stage} cold stage`)
    },
  }
}

vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage', () => coldStageModule('config'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ScriptStage', () => coldStageModule('script'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/StoryboardStage', () => coldStageModule('storyboard'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VideoStageRoute', () => coldStageModule('videos'))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VoiceStageRoute', () => coldStageModule('voice'))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkspaceStageContent cold dynamic boundary', () => {
  it('loads only the active stage module from an isolated cold module graph', async () => {
    render(React.createElement(WorkspaceStageContent, {
      currentStage: 'config',
      projectId: 'project-1',
      episodeId: 'episode-1',
    }))

    await waitFor(() => expect(coldLoads.config).toBe(1))
    expect(coldLoads).toEqual({
      config: 1,
      script: 0,
      storyboard: 0,
      videos: 0,
      voice: 0,
    })
  })
})
