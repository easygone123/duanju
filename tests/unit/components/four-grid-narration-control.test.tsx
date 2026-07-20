// @vitest-environment jsdom

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PanelNarrationControl from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/PanelNarrationControl'
import type { StoryboardPanel } from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardState'
import { queryKeys } from '@/lib/query/keys'

const apiFetchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))

afterEach(cleanup)

const messages = {
  storyboard: { sixGrid: { panel: { narration: {
    title: 'Narration', aiRecommended: 'AI recommended', aiNotRecommended: 'AI not recommended',
    auto: 'Auto', on: 'On', off: 'Off', text: 'Narration text', emotion: 'Emotion',
    save: 'Save', saving: 'Saving…', required: 'Narration text is required.',
    stale: 'This panel changed elsewhere. Refresh and try again.',
    failure: 'Could not save narration. Please try again.',
    aiHint: 'Using the AI suggestion', manualHint: 'Manual narration draft',
  } } } },
}

const basePanel: StoryboardPanel = {
  id: 'panel-1',
  panelIndex: 0,
  panel_number: 1,
  shot_type: 'wide',
  camera_move: null,
  description: 'A quiet return home.',
  characters: [],
  hasDialogue: false,
  narrationMode: 'auto',
  narrationRecommended: true,
  narrationSuggestedText: 'Years later, Ming returned.',
  narrationSuggestedEmotion: 'reflective',
  narrationText: null,
  narrationEmotion: null,
  updatedAt: '2026-07-20T03:00:00.000Z',
}

function renderControl(panel: StoryboardPanel = basePanel) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
  const view = render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PanelNarrationControl projectId="project-1" episodeId="episode-1" panel={panel} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  )
  return { ...view, queryClient, invalidate }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function canonical(overrides: Partial<Pick<StoryboardPanel,
  | 'narrationMode'
  | 'narrationRecommended'
  | 'narrationSuggestedText'
  | 'narrationSuggestedEmotion'
  | 'narrationText'
  | 'narrationEmotion'
  | 'updatedAt'>> = {}) {
  return {
    narrationMode: 'on',
    narrationRecommended: true,
    narrationSuggestedText: 'Years later, Ming returned.',
    narrationSuggestedEmotion: 'reflective',
    narrationText: 'Manual narration',
    narrationEmotion: 'urgent',
    updatedAt: '2026-07-20T03:05:00.000Z',
    ...overrides,
  }
}

describe('four-grid panel narration control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders no narration control for a dialogue panel', () => {
    const view = renderControl({ ...basePanel, hasDialogue: true })
    expect(view.queryByTestId('panel-narration-control')).toBeNull()
  })

  it('shows the AI recommendation and suggestion in auto mode', () => {
    const view = renderControl()
    expect(view.getByText('AI recommended')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Years later, Ming returned.')
    expect(view.getByRole('textbox', { name: 'Emotion' })).toHaveValue('reflective')
  })

  it('copies the suggestion into a manual draft when switching on', () => {
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    expect(view.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Years later, Ming returned.')
    expect(view.getByRole('textbox', { name: 'Emotion' })).toHaveValue('reflective')
  })

  it('switches to on when either displayed AI field is edited', () => {
    const view = renderControl()
    fireEvent.change(view.getByRole('textbox', { name: 'Emotion' }), { target: { value: 'hopeful' } })
    expect(view.getByRole('button', { name: 'On' }).getAttribute('aria-pressed')).toBe('true')
    expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Years later, Ming returned.')
    expect(view.getByRole('textbox', { name: 'Emotion' })).toHaveValue('hopeful')
  })

  it('keeps the manual draft while off and restores it when switched back on', () => {
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Narration text' }), { target: { value: 'Keep this draft' } })
    fireEvent.click(view.getByRole('button', { name: 'Off' }))
    expect(view.queryByRole('textbox', { name: 'Narration text' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Keep this draft')
  })

  it('blocks saving on with blank narration text', () => {
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Narration text' }), { target: { value: '   ' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    expect(view.getByRole('alert')).toHaveTextContent('Narration text is required.')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('sends the exact patch, adopts the canonical response, and invalidates all dependent queries', async () => {
    apiFetchMock.mockResolvedValueOnce(response({
      success: true,
      narration: canonical({ narrationText: 'Canonical manual narration', narrationEmotion: 'canonical calm' }),
    }))
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Narration text' }), { target: { value: 'Manual narration' } })
    fireEvent.change(view.getByRole('textbox', { name: 'Emotion' }), { target: { value: 'urgent' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/novel-promotion/project-1/panels/panel-1/narration',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'on',
          text: 'Manual narration',
          emotion: 'urgent',
          locale: 'en',
          expectedPanelUpdatedAt: '2026-07-20T03:00:00.000Z',
        }),
      },
    ))
    await waitFor(() => expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Canonical manual narration'))
    expect(view.getByRole('textbox', { name: 'Emotion' })).toHaveValue('canonical calm')
    expect(view.invalidate).toHaveBeenCalledTimes(4)
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.episodeStage('project-1', 'episode-1', 'storyboard') })
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.episodeData('project-1', 'episode-1') })
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.voiceLines.all('episode-1') })
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.voiceLines.matched('project-1', 'episode-1') })
  })

  it.each([
    ['stale', response({ success: false, error: { code: 'CONFLICT', details: { code: 'PANEL_NARRATION_STALE' } } }, 409), 'This panel changed elsewhere. Refresh and try again.'],
    ['generic', response({ success: false, error: { code: 'INTERNAL_ERROR' } }, 500), 'Could not save narration. Please try again.'],
  ] as const)('preserves the draft and shows a localized %s save error', async (_case, failureResponse, message) => {
    apiFetchMock.mockResolvedValueOnce(failureResponse)
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'On' }))
    fireEvent.change(view.getByRole('textbox', { name: 'Narration text' }), { target: { value: 'Unsaved manual draft' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(message))
    expect(view.getByRole('textbox', { name: 'Narration text' })).toHaveValue('Unsaved manual draft')
  })

  it('disables selector, fields, and save action while saving', async () => {
    let settle!: (value: Response) => void
    apiFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const view = renderControl()
    fireEvent.click(view.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(view.getByRole('button', { name: 'Saving…' })).toBeDisabled())
    expect(view.getByRole('button', { name: 'Auto' })).toBeDisabled()
    expect(view.getByRole('button', { name: 'On' })).toBeDisabled()
    expect(view.getByRole('button', { name: 'Off' })).toBeDisabled()
    expect(view.getByRole('textbox', { name: 'Narration text' })).toBeDisabled()
    expect(view.getByRole('textbox', { name: 'Emotion' })).toBeDisabled()

    await act(async () => {
      settle(response({ success: true, narration: canonical() }))
    })
  })
})
