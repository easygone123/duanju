// @vitest-environment jsdom

import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ConfigStage from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/ConfigStage'
import {
  WorkspaceStageRuntimeProvider,
  type WorkspaceStageRuntimeValue,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceStageRuntimeContext'

const apiFetchMock = vi.hoisted(() => vi.fn())
const workspaceContext = vi.hoisted(() => ({ projectId: 'project-1', episodeId: 'episode-1' }))

vi.mock('@/lib/api-fetch', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/WorkspaceProvider', () => ({
  useWorkspaceProvider: () => workspaceContext,
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'project-1' }) }))
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))
vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children }: { children: React.ReactNode }) => React.createElement('a', null, children),
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/SmartImportWizard', () => ({
  default: () => React.createElement('div', null, 'Smart import'),
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/NovelInputStage', () => ({
  default: ({ novelText }: { novelText: string }) => React.createElement('textarea', {
    'aria-label': 'Novel text', value: novelText, readOnly: true,
  }),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function configResponse(novelText: string) {
  return new Response(JSON.stringify({
    stage: 'config',
    episode: {
      id: 'episode-1', name: 'Episode', novelText,
      readiness: { hasStory: true, hasScript: false, hasStoryboard: false, hasVideo: false, hasVoice: false },
      storyboardStats: { storyboardCount: 0, panelCount: 0 },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

const runtime = {
  assetsLoading: false,
  isSubmittingTTS: false,
  isTransitioning: false,
  isConfirmingAssets: false,
  isStartingStoryToScript: false,
  isStartingScriptToStoryboard: false,
  isScriptToStoryboardRunning: false,
  videoRatio: '9:16',
  storyboardGenerationMode: 'individual',
  sixGridCellAspectRatio: null,
  sixGridProcessingOrder: 'crop_then_panel_upscale',
  storyboardUpscaleModel: null,
  dialogueVideoModel: null,
  artStyle: 'realistic',
  videoModel: '',
  capabilityOverrides: {},
  userUpscaleModels: [],
  userVideoModels: [],
  onNovelTextChange: vi.fn(async () => undefined),
  onVideoRatioChange: vi.fn(async () => undefined),
  onArtStyleChange: vi.fn(async () => undefined),
  onStoryboardConfigChange: vi.fn(async () => true),
  onRunStoryToScript: vi.fn(async () => undefined),
  onClipUpdate: vi.fn(async () => undefined),
  onOpenAssetLibrary: vi.fn(),
  onRunScriptToStoryboard: vi.fn(async () => undefined),
  onStageChange: vi.fn(),
  onGenerateVideo: vi.fn(async () => undefined),
  onGenerateAllVideos: vi.fn(async () => undefined),
  onUpdateVideoPrompt: vi.fn(async () => undefined),
  onUpdatePanelVideoModel: vi.fn(async () => undefined),
  onOpenAssetLibraryForCharacter: vi.fn(),
} as unknown as WorkspaceStageRuntimeValue

const TestRuntimeProvider = WorkspaceStageRuntimeProvider as React.ComponentType<{
  value: WorkspaceStageRuntimeValue
  children?: React.ReactNode
}>

function renderConfig(queryClient: QueryClient) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        TestRuntimeProvider,
        { value: runtime },
        React.createElement(ConfigStage),
      ),
    ),
  )
}

afterEach(cleanup)

describe('workspace stage data boundary', () => {
  beforeEach(() => {
    Reflect.set(globalThis, 'React', React)
    apiFetchMock.mockReset()
  })

  it('keeps config controls absent while the first stage GET is pending, then reveals loaded data', async () => {
    const pending = deferred<Response>()
    apiFetchMock.mockImplementationOnce(() => pending.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    renderConfig(queryClient)

    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByRole('textbox', { name: 'Novel text' })).toBeNull()

    pending.resolve(configResponse('loaded story'))
    expect((await screen.findByRole('textbox', { name: 'Novel text' }) as HTMLTextAreaElement).value).toBe('loaded story')
  })

  it('shows an alert and retries a failed first stage GET before enabling config controls', async () => {
    apiFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stage unavailable' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(configResponse('retry story'))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    renderConfig(queryClient)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('stage unavailable')
    expect(screen.queryByRole('textbox', { name: 'Novel text' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry loading stage data' }))
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    expect((await screen.findByRole('textbox', { name: 'Novel text' }) as HTMLTextAreaElement).value).toBe('retry story')
  })

  it('keeps stale config controls available during a background refetch', async () => {
    const background = deferred<Response>()
    apiFetchMock
      .mockResolvedValueOnce(configResponse('stale story'))
      .mockImplementationOnce(() => background.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderConfig(queryClient)
    await waitFor(() => expect(
      (screen.getByRole('textbox', { name: 'Novel text' }) as HTMLTextAreaElement).value,
    ).toBe('stale story'))

    await act(async () => {
      void queryClient.refetchQueries({ queryKey: ['episode-stages', 'project-1', 'episode-1', 'config'] })
    })

    expect((screen.getByRole('textbox', { name: 'Novel text' }) as HTMLTextAreaElement).value).toBe('stale story')
    expect(screen.queryByRole('status')).toBeNull()
    background.resolve(configResponse('fresh story'))
    expect(await screen.findByDisplayValue('fresh story')).not.toBeNull()
  })
})
