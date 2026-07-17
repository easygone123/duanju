// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SixGridPromptModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridPromptModal'
import SixGridUploadModal from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridUploadModal'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  isSixGridSheetRatioAllowed,
} from '@/lib/novel-promotion/six-grid/upload-contract'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}))

const messages = {
  storyboard: { sixGrid: {
    promptModal: {
      title: 'Six-grid prompt', description: 'Stored planning prompt',
      groupContext: 'Group {sequence}', cellRatioContext: 'Cell ratio {ratio}',
      promptLabel: 'Stored prompt', copy: 'Copy prompt', copied: 'Prompt copied',
      copyFailed: 'Could not copy the prompt', missing: 'Rerun storyboard planning to create the stored prompt.',
      close: 'Close',
    },
    uploadModal: {
      title: 'Upload six-grid sheet', description: 'Replace the generated sheet with an external image.',
      chooseFile: 'Choose image', dropFile: 'or drop an image here', supportedTypes: 'PNG, JPEG, or WebP up to 25 MiB',
      fileLabel: 'File', sizeLabel: 'Size', dimensionsLabel: 'Dimensions',
      expectedRatioLabel: 'Expected sheet ratio', detectedRatioLabel: 'Detected ratio',
      previewAlt: 'Selected six-grid sheet preview',
      ratioPending: 'Detecting…',
      cellRatioContext: 'Cell ratio {ratio}', cellRatioLabel: 'Cell ratio',
      replacementWarning: 'This replaces the current six-grid sheet and derived panels.',
      invalidType: 'Choose a PNG, JPEG, or WebP image.', invalidImage: 'The selected file is not a valid image.',
      tooLarge: 'The selected image exceeds the upload limit.', dimensionsInvalid: 'The decoded image dimensions exceed the limit.',
      ratioInvalid: 'The image ratio does not match the six-grid layout.', uploadFailed: 'Upload failed. Try again.',
      uploading: 'Uploading…', cancel: 'Cancel', confirm: 'Upload sheet',
    },
  } },
}

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>
  )
}

function imageFile(name = 'sheet.png', type = 'image/png') {
  return new File(['image'], name, { type })
}

type BitmapStub = { width: number; height: number; close: ReturnType<typeof vi.fn> }
function bitmap(width: number, height: number): BitmapStub {
  return { width, height, close: vi.fn() }
}

const createImageBitmapMock = vi.fn()
const createObjectURLMock = vi.fn<(blob: Blob | MediaSource) => string>()
const revokeObjectURLMock = vi.fn<(url: string) => void>()
const clipboardWriteMock = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  vi.clearAllMocks()
  createObjectURLMock.mockImplementation((file) => `blob:${(file as File).name}:${createObjectURLMock.mock.calls.length}`)
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: createImageBitmapMock })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteMock },
  })
  clipboardWriteMock.mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('six-grid prompt modal', () => {
  it('shows contextual stored text as readonly and copies the exact string', async () => {
    const prompt = '  first line\nsecond line  '
    const view = render(withIntl(
      <SixGridPromptModal open onClose={vi.fn()} prompt={prompt} groupSequence={4} cellRatio="16:9" />,
    ))

    expect(view.getByRole('heading', { name: 'Six-grid prompt' })).toBeTruthy()
    const textbox = view.getByRole('textbox', { name: 'Stored prompt' }) as HTMLTextAreaElement
    expect(textbox.readOnly).toBe(true)
    expect(textbox.value).toBe(prompt)
    expect(view.getByText('Group 4')).toBeTruthy()
    expect(view.getByText('Cell ratio 16:9')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(clipboardWriteMock).toHaveBeenCalledWith(prompt))
    expect(view.getByRole('status').textContent).toBe('Prompt copied')
  })

  it('resets copy success when prompt changes and reports a sanitized clipboard failure', async () => {
    const view = render(withIntl(
      <SixGridPromptModal open onClose={vi.fn()} prompt="first" groupSequence={1} cellRatio="16:9" />,
    ))
    fireEvent.click(view.getByRole('button', { name: 'Copy prompt' }))
    await view.findByText('Prompt copied')

    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(view.queryByText('Prompt copied')).toBeNull())

    view.rerender(withIntl(
      <SixGridPromptModal open onClose={vi.fn()} prompt="second" groupSequence={1} cellRatio="16:9" />,
    ))
    await waitFor(() => expect(view.queryByText('Prompt copied')).toBeNull())

    clipboardWriteMock.mockRejectedValueOnce(new Error('browser-secret-detail'))
    fireEvent.click(view.getByRole('button', { name: 'Copy prompt' }))
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toBe('Could not copy the prompt')
    expect(alert.textContent).not.toContain('browser-secret-detail')
  })

  it('guides replanning when the stored prompt is blank', () => {
    const view = render(withIntl(
      <SixGridPromptModal open onClose={vi.fn()} prompt={'  \n '} groupSequence={null} cellRatio="9:16" />,
    ))
    expect(view.getByText('Rerun storyboard planning to create the stored prompt.')).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.queryByRole('button', { name: 'Copy prompt' })).toBeNull()
  })
})

describe('six-grid external upload modal', () => {
  it('accepts a valid landscape-cell sheet and submits the frozen artifact version', async () => {
    const decoded = bitmap(2400, 900)
    createImageBitmapMock.mockResolvedValueOnce(decoded)
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    const onClose = vi.fn()
    const view = render(withIntl(
      <SixGridUploadModal open onClose={onClose} cellRatio="16:9" expectedSheetArtifactVersion={7} onSubmit={onSubmit} />,
    ))
    const file = imageFile()

    fireEvent.change(view.getByLabelText('Choose image'), { target: { files: [file] } })
    await waitFor(() => expect(view.getByText('2400 × 900')).toBeTruthy())
    expect(view.getByText('8:3')).toBeTruthy()
    expect(decoded.close).toHaveBeenCalledTimes(1)

    const confirm = view.getByRole('button', { name: 'Upload sheet' })
    expect(confirm.hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(confirm) })

    expect(onSubmit).toHaveBeenCalledWith(file, 7)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('accepts valid portrait cells and the 3% boundary but rejects just outside it', async () => {
    expect(isSixGridSheetRatioAllowed((27 / 32) * 1.03, '9:16')).toBe(true)
    expect(isSixGridSheetRatioAllowed((27 / 32) * 1.03001, '9:16')).toBe(false)

    createImageBitmapMock
      .mockResolvedValueOnce(bitmap(2700, 3200))
      .mockResolvedValueOnce(bitmap(2781, 3200))
      .mockResolvedValueOnce(bitmap(2782, 3200))
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const view = render(withIntl(
      <SixGridUploadModal open onClose={vi.fn()} cellRatio="9:16" expectedSheetArtifactVersion={3} onSubmit={onSubmit} />,
    ))
    const input = view.getByLabelText('Choose image')

    fireEvent.change(input, { target: { files: [imageFile('portrait.png')] } })
    await waitFor(() => expect(view.getByText('2700 × 3200')).toBeTruthy())
    expect(view.getByRole('button', { name: 'Upload sheet' }).hasAttribute('disabled')).toBe(false)

    fireEvent.change(input, { target: { files: [imageFile('boundary.png')] } })
    await waitFor(() => expect(view.getByText('2781 × 3200')).toBeTruthy())
    expect(view.getByRole('button', { name: 'Upload sheet' }).hasAttribute('disabled')).toBe(false)

    fireEvent.change(input, { target: { files: [imageFile('outside.png')] } })
    expect((await view.findByRole('alert')).textContent).toBe('The image ratio does not match the six-grid layout.')
    expect(view.getByRole('button', { name: 'Upload sheet' }).hasAttribute('disabled')).toBe(true)
  })

  it('blocks wrong ratio, invalid type, oversized bytes, decode failure, and decoded dimension limits', async () => {
    createImageBitmapMock
      .mockResolvedValueOnce(bitmap(1000, 1000))
      .mockRejectedValueOnce(new Error('decoder internals'))
      .mockResolvedValueOnce(bitmap(16_385, 1))
    const onSubmit = vi.fn()
    const view = render(withIntl(
      <SixGridUploadModal open onClose={vi.fn()} cellRatio="16:9" expectedSheetArtifactVersion={2} onSubmit={onSubmit} />,
    ))
    const input = view.getByLabelText('Choose image')

    fireEvent.change(input, { target: { files: [imageFile('wrong.png')] } })
    expect(await view.findByText('The image ratio does not match the six-grid layout.')).toBeTruthy()

    const decodeCalls = createImageBitmapMock.mock.calls.length
    fireEvent.change(input, { target: { files: [imageFile('text.txt', 'text/plain')] } })
    expect(await view.findByText('Choose a PNG, JPEG, or WebP image.')).toBeTruthy()
    expect(createImageBitmapMock).toHaveBeenCalledTimes(decodeCalls)

    const huge = imageFile('huge.png')
    Object.defineProperty(huge, 'size', { value: SIX_GRID_UPLOAD_MAX_BYTES + 1 })
    fireEvent.change(input, { target: { files: [huge] } })
    expect(await view.findByText('The selected image exceeds the upload limit.')).toBeTruthy()
    expect(createImageBitmapMock).toHaveBeenCalledTimes(decodeCalls)

    fireEvent.change(input, { target: { files: [imageFile('broken.png')] } })
    expect(await view.findByText('The selected file is not a valid image.')).toBeTruthy()
    expect(view.queryByText('decoder internals')).toBeNull()

    fireEvent.change(input, { target: { files: [imageFile('dimensions.png')] } })
    expect(await view.findByText('The decoded image dimensions exceed the limit.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps the dialog open on upload failure and prevents duplicate submit or close while pending', async () => {
    createImageBitmapMock.mockResolvedValueOnce(bitmap(2400, 900))
    let rejectUpload!: (error: Error) => void
    const pending = new Promise((_, reject) => { rejectUpload = reject })
    const onSubmit = vi.fn().mockReturnValue(pending)
    const onClose = vi.fn()
    const view = render(withIntl(
      <SixGridUploadModal open onClose={onClose} cellRatio="16:9" expectedSheetArtifactVersion={9} onSubmit={onSubmit} />,
    ))
    fireEvent.change(view.getByLabelText('Choose image'), { target: { files: [imageFile()] } })
    await view.findByText('2400 × 900')

    fireEvent.click(view.getByRole('button', { name: 'Upload sheet' }))
    expect(await view.findByText('Uploading…')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Uploading…' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => { rejectUpload(new Error('private server detail')); await pending.catch(() => undefined) })
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toBe('Upload failed. Try again.')
    expect(alert.textContent).not.toContain('private server detail')
    expect(view.getByRole('dialog')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('revokes previews on replacement, close, and unmount, and ignores stale decoding', async () => {
    let resolveFirst!: (value: BitmapStub) => void
    const firstDecode = new Promise<BitmapStub>((resolve) => { resolveFirst = resolve })
    createImageBitmapMock
      .mockReturnValueOnce(firstDecode)
      .mockResolvedValueOnce(bitmap(2400, 900))
    const onClose = vi.fn()
    const view = render(withIntl(
      <SixGridUploadModal open onClose={onClose} cellRatio="16:9" expectedSheetArtifactVersion={1} onSubmit={vi.fn()} />,
    ))
    const input = view.getByLabelText('Choose image')
    fireEvent.change(input, { target: { files: [imageFile('slow.png')] } })
    fireEvent.change(input, { target: { files: [imageFile('new.png')] } })

    await waitFor(() => expect(view.getByText('new.png')).toBeTruthy())
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:slow.png:1')
    await act(async () => { resolveFirst(bitmap(1000, 1000)); await firstDecode })
    expect(view.getByText('new.png')).toBeTruthy()
    expect(view.queryByText('1000 × 1000')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:new.png:2')
    view.unmount()

    createImageBitmapMock.mockResolvedValueOnce(bitmap(2400, 900))
    const second = render(withIntl(
      <SixGridUploadModal open onClose={vi.fn()} cellRatio="16:9" expectedSheetArtifactVersion={1} onSubmit={vi.fn()} />,
    ))
    fireEvent.change(second.getByLabelText('Choose image'), { target: { files: [imageFile('unmount.png')] } })
    await second.findByText('unmount.png')
    second.unmount()
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:unmount.png:3')
  })
})

describe('six-grid storyboard group dialog wiring', () => {
  it('freezes the artifact version when upload opens and retains the virtual card for either dialog', async () => {
    const retentionMock = vi.fn()
    vi.doMock('@/components/virtualization/VirtualCardRange', () => ({
      useVirtualCardRetention: retentionMock,
    }))
    vi.doMock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardGroupTaskErrors', () => ({
      useStoryboardGroupTaskErrors: () => ({ panelTaskErrorMap: new Map(), clearPanelTaskError: vi.fn() }),
    }))
    vi.doMock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/hooks/useStoryboardInsertVariantRuntime', () => ({
      useStoryboardInsertVariantRuntime: () => ({
        insertModalOpen: false, insertAfterPanel: null, nextPanelForInsert: null, variantModalPanel: null,
        handleOpenInsertModal: vi.fn(), handleCloseInsertModal: vi.fn(), handleInsert: vi.fn(),
        handleOpenVariantModal: vi.fn(), handleCloseVariantModal: vi.fn(), handleVariant: vi.fn(),
      }),
    }))
    vi.doMock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridGroupControls', () => ({
      default: ({ onViewPrompt, onUploadSheet }: { onViewPrompt(): void; onUploadSheet(): void }) => (
        <div><button onClick={onViewPrompt}>OPEN PROMPT</button><button onClick={onUploadSheet}>OPEN UPLOAD</button></div>
      ),
    }))
    vi.doMock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridPromptModal', () => ({
      default: ({ open, onClose }: { open: boolean; onClose(): void }) => open
        ? <div data-testid="prompt-dialog"><button onClick={onClose}>CLOSE PROMPT</button></div>
        : null,
    }))
    vi.doMock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/SixGridUploadModal', () => ({
      default: ({ open, expectedSheetArtifactVersion, onSubmit }: {
        open: boolean
        expectedSheetArtifactVersion: number
        onSubmit(file: File, version: number): Promise<unknown>
      }) => open ? (
        <div data-testid="upload-dialog" data-version={expectedSheetArtifactVersion}>
          <button onClick={() => void onSubmit(imageFile('replacement.png'), expectedSheetArtifactVersion)}>SUBMIT UPLOAD</button>
        </div>
      ) : null,
    }))
    for (const path of [
      'ScreenplayDisplay', 'StoryboardGroupHeader', 'StoryboardGroupActions', 'StoryboardPanelList',
      'StoryboardGroupFailedAlert', 'StoryboardGroupDialogs', 'SixGridCropModal',
    ]) {
      vi.doMock(`@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/${path}`, () => ({ default: () => null }))
    }
    vi.doMock('@/components/task/TaskStatusOverlay', () => ({ default: () => null }))

    const StoryboardGroup = (await import(
      '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/storyboard/StoryboardGroup'
    )).default
    const onUploadSixGridSheet = vi.fn().mockResolvedValue(undefined)
    const noop = () => undefined
    const asyncNoop = async () => undefined
    const storyboard = {
      id: 'storyboard-1', episodeId: 'episode-1', clipId: 'clip-1', storyboardTextJson: null,
      panelCount: 6, storyboardImageUrl: null, layoutMode: 'six_grid' as const, groupSequence: 2,
      sixGridCellAspectRatio: '16:9' as const, sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
      sheetPromptSnapshot: 'stored prompt', sheetArtifactVersion: 4, panels: [],
    }
    const props = {
      storyboard, clip: undefined, sbIndex: 0, totalStoryboards: 1, textPanels: [], storyboardStartIndex: 0,
      videoRatio: '16:9', isExpanded: false, isSubmittingStoryboardTask: false, isSelectingCandidate: false,
      isSubmittingStoryboardTextTask: false, hasAnyImage: false, failedError: null,
      savingPanels: new Set(), deletingPanelIds: new Set(), saveStateByPanel: {}, hasUnsavedByPanel: new Set(),
      modifyingPanels: new Set(), submittingPanelImageIds: new Set(), movingClipId: null, insertingAfterPanelId: null,
      projectId: 'project-1', episodeId: 'episode-1', submittingVariantPanelId: null, sixGridUpscaleWorkflow: null,
      isSixGridTaskRunning: false, sixGridTaskPanelId: null, sixGridGenerationError: null,
      onToggleExpand: noop, onMoveUp: noop, onMoveDown: noop, onRegenerateText: noop, onAddPanel: noop,
      onDeleteStoryboard: noop, onGenerateAllIndividually: noop, onPreviewImage: noop, onCloseError: noop,
      getPanelEditData: () => ({}), onPanelUpdate: noop, onPanelDelete: noop, onOpenCharacterPicker: noop,
      onOpenLocationPicker: noop, onRemoveCharacter: noop, onRemoveLocation: noop, onRetryPanelSave: noop,
      onRegeneratePanelImage: async () => true, onOpenEditModal: noop, onOpenAIDataModal: noop,
      getPanelCandidates: () => null, onSelectPanelCandidateIndex: noop, onConfirmPanelCandidate: asyncNoop,
      onCancelPanelCandidate: noop, formatClipTitle: () => '', onInsertPanel: asyncNoop, onPanelVariant: asyncNoop,
      onGenerateSixGridSheet: noop, onUpscaleSixGridSheet: noop, onCropSixGridSheet: asyncNoop,
      onUploadSixGridSheet, onUpscaleSixGridPanel: asyncNoop, onUndoSixGridPanel: asyncNoop,
    } as unknown as React.ComponentProps<typeof StoryboardGroup>

    const view = render(withIntl(<StoryboardGroup {...props} />))
    expect(retentionMock).toHaveBeenLastCalledWith(false)

    fireEvent.click(view.getByRole('button', { name: 'OPEN PROMPT' }))
    expect(view.getByTestId('prompt-dialog')).toBeTruthy()
    expect(retentionMock).toHaveBeenLastCalledWith(true)
    fireEvent.click(view.getByRole('button', { name: 'CLOSE PROMPT' }))

    fireEvent.click(view.getByRole('button', { name: 'OPEN UPLOAD' }))
    expect(view.getByTestId('upload-dialog').getAttribute('data-version')).toBe('4')
    expect(retentionMock).toHaveBeenLastCalledWith(true)

    view.rerender(withIntl(<StoryboardGroup {...props} storyboard={{ ...storyboard, sheetArtifactVersion: 11 }} />))
    expect(view.getByTestId('upload-dialog').getAttribute('data-version')).toBe('4')
    fireEvent.click(view.getByRole('button', { name: 'SUBMIT UPLOAD' }))
    await waitFor(() => expect(onUploadSixGridSheet).toHaveBeenCalledWith(expect.any(File), 4))
  })
})
