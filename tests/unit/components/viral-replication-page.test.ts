// @vitest-environment jsdom

import React, { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ViralReplicationPage from '@/components/viral-replication/ViralReplicationPage'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const state = vi.hoisted(() => ({
  detail: null as Record<string, unknown> | null,
  replace: vi.fn(),
  patch: vi.fn(),
  retry: vi.fn(),
  generate: vi.fn(),
  useSSE: vi.fn(),
}))

vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace: state.replace }) }))
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }))
vi.mock('@/lib/query/hooks/useSSE', () => ({ useSSE: (options: unknown) => state.useSSE(options) }))
vi.mock('@/lib/query/hooks/useViralReplication', () => ({
  useViralReplication: () => ({ data: state.detail, isLoading: false, error: null }),
  usePatchViralReplicationBrief: () => ({ mutateAsync: state.patch, isPending: false }),
  useRetryViralReplication: () => ({ mutateAsync: state.retry, isPending: false }),
  useGenerateViralReplication: () => ({ mutateAsync: state.generate, isPending: false }),
}))

const report = {
  schemaVersion: 1,
  overview: {
    hook: 'Immediate conflict',
    coreAppeal: 'A satisfying reversal',
    pacing: 'Fast opening, measured payoff',
    emotionalArc: 'Tension to relief',
  },
  sourceStory: {
    summary: 'A visitor returns and opens a long-awaited door.',
    premise: 'Someone waits for a visitor to return.',
    characterRelations: ['The visitor and host know each other.'],
    storyBeats: [{
      shotIndexes: [0],
      beat: 'The visitor returns and the door opens.',
      cause: 'The host has been waiting.',
      effect: 'Their reunion begins.',
    }],
  },
  styleFingerprint: {
    composition: ['centered close-ups'],
    lighting: ['high contrast'],
    color: ['warm highlights'],
    editing: ['hard cuts'],
  },
  shots: [{
    shotIndex: 0,
    startMs: 0,
    endMs: 1_000,
    shotType: 'close-up',
    cameraAngle: 'eye-level',
    cameraMove: 'static',
    composition: 'subject centered',
    actionBeat: 'hero opens the door',
    transition: 'cut',
    subtitleSummary: 'You came back.',
    narrativeFunction: 'hook',
    visibleCharacters: ['visitor', 'host'],
    speaker: 'host',
    location: 'front doorway',
    props: ['door'],
    dialogueIntent: 'recognizes the returning visitor',
    plotBeat: 'the host opens the door to the returning visitor',
    causalLink: null,
    analysisConfidence: 0.94,
    needsVisualReview: false,
  }],
  originalAdaptationAdvice: ['Keep the conflict, replace the setting.'],
}

function detail(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'rep-1',
    status,
    brief: 'Original urban reversal',
    durationMs: 1_000,
    project: { id: 'project-1', name: 'Replication project' },
    episode: { id: 'episode-1', episodeNumber: 1, name: 'Episode 1' },
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('ViralReplicationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.patch.mockResolvedValue({})
    state.retry.mockResolvedValue({})
    state.generate.mockResolvedValue({})
  })

  it('renders upload validation, five analysis stages, and an active SSE subscription', () => {
    state.detail = detail('uploading')
    const view = render(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('states.uploadingValidation')).toBeTruthy()

    state.detail = detail('analyzing')
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getAllByTestId('viral-progress-stage')).toHaveLength(5)
    expect(state.useSSE).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true, projectId: 'project-1', episodeId: 'episode-1',
    }))
  })

  it('renders only a parser-accepted report and saves the brief before generating', async () => {
    state.detail = detail('review_ready', { reportJson: report })
    const view = render(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))

    for (const text of [
      'Immediate conflict', 'A satisfying reversal', 'Fast opening, measured payoff',
      'Tension to relief', 'centered close-ups', 'close-up', 'eye-level', 'static',
      'hero opens the door', 'cut', 'You came back.', 'hook',
      'A visitor returns and opens a long-awaited door.',
      'Someone waits for a visitor to return.',
      'The visitor and host know each other.',
      'the host opens the door to the returning visitor',
      '94%',
      'Keep the conflict, replace the setting.',
    ]) expect(view.getByText(text)).toBeTruthy()
    expect(view.getByText('audioSubtitleNotice')).toBeTruthy()

    fireEvent.change(view.getByLabelText('brief.label'), { target: { value: 'New original brief' } })
    fireEvent.click(view.getByRole('button', { name: 'actions.generate' }))
    await waitFor(() => expect(state.generate).toHaveBeenCalledWith('New original brief'))
    expect(state.patch).toHaveBeenCalledWith('New original brief')
    expect(state.patch.mock.invocationCallOrder[0]).toBeLessThan(state.generate.mock.invocationCallOrder[0])
  })

  it('rejects invalid report data, locks generation edits, and offers stage-aware retry on failure', () => {
    state.detail = detail('review_ready', { reportJson: { ...report, schemaVersion: 2 } })
    const view = render(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.invalidReport')).toBeTruthy()
    expect(view.queryByText('Immediate conflict')).toBeNull()

    state.detail = detail('generating', { reportJson: report })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect((view.getByLabelText('brief.label') as HTMLTextAreaElement).disabled).toBe(true)
    expect(view.getByTestId('viral-generation-progress')).toBeTruthy()

    state.detail = detail('failed', { errorMessage: 'sensitive internal details' })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.generic')).toBeTruthy()
    expect(view.queryByText('sensitive internal details')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'actions.retry' }))
    expect(state.retry).toHaveBeenCalledTimes(1)

    state.detail = detail('failed', { errorMessage: 'VIRAL_STORYBOARD_GENERATION_FAILED' })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.storyboardGeneration')).toBeTruthy()

    state.detail = detail('failed', { errorMessage: 'VIRAL_AUDIO_TRANSCRIPTION_FAILED' })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.audioTranscription')).toBeTruthy()

    state.detail = detail('failed', { errorMessage: 'VIRAL_ANALYSIS_FAILED' })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.analysis')).toBeTruthy()
  })

  it('rejects project ownership mismatch and navigates a completed result exactly once', async () => {
    state.detail = detail('review_ready', {
      project: { id: 'different-project', name: 'Wrong project' }, reportJson: report,
    })
    const view = render(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(view.getByText('errors.projectMismatch')).toBeTruthy()
    expect(view.queryByText('Immediate conflict')).toBeNull()

    state.detail = detail('completed')
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    await waitFor(() => expect(state.replace).toHaveBeenCalledTimes(1))
    expect(state.replace).toHaveBeenCalledWith({
      pathname: '/workspace/project-1',
      query: { stage: 'storyboard', episode: 'episode-1' },
    })
    view.rerender(createElement(ViralReplicationPage, {
      projectId: 'project-1', replicationId: 'rep-1',
    }))
    expect(state.replace).toHaveBeenCalledTimes(1)
  })
})
