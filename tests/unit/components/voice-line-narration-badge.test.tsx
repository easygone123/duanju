// @vitest-environment jsdom

import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => ({
    'lineCard.narrationBadge': 'Narration',
    'lineCard.editLine': 'Edit line',
    'lineCard.deleteLine': 'Delete line',
    'lineEditor.contentLabel': 'Line Content',
    'lineEditor.speakerLabel': 'Speaker',
    'lineEditor.bindPanelLabel': 'Bind Shot',
    'lineEditor.narrationIdentityHint': 'Identity managed in storyboard',
    'lineEditor.editTitle': 'Edit Voice Line',
    'lineEditor.contentPlaceholder': 'Enter content',
    'lineEditor.selectSpeaker': 'Select speaker',
    'lineEditor.unboundPanel': 'Unbound',
    'lineEditor.saveEdit': 'Save',
    'common.cancel': 'Cancel',
    'common.generate': 'Generate',
  }[key] || key),
}))

vi.mock('@/components/ui/icons', () => ({
  AppIcon: ({ name }: { name: string }) => React.createElement('span', null, name),
}))
vi.mock('@/components/virtualization/VirtualCardRange', () => ({
  useVirtualCardRetention: vi.fn(),
}))
vi.mock('@/components/task/TaskStatusInline', () => ({ default: () => null }))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/EmotionSettingsPanel', () => ({
  default: () => null,
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/VoiceToolbar', () => ({
  default: () => null,
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/EmbeddedVoiceToolbar', () => ({
  default: () => null,
}))
vi.mock('@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/SpeakerVoiceStatus', () => ({
  default: () => null,
}))

import VoiceLineCard from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice/VoiceLineCard'
import VoiceControlPanel from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/voice-stage/VoiceControlPanel'

afterEach(cleanup)

const narrationLine = {
  id: 'narration-1',
  lineIndex: 1,
  lineType: 'narration' as const,
  enabled: true,
  sourceKey: 'panel-narration:panel-1',
  speaker: 'Narrator',
  content: 'Years later, she returned.',
  emotionPrompt: null,
  emotionStrength: null,
  audioUrl: null,
  updatedAt: '2026-07-20T00:00:00.000Z',
  lineTaskRunning: false,
  matchedPanelId: 'panel-1',
  matchedStoryboardId: 'storyboard-1',
  matchedPanelIndex: 0,
}

function renderCard(lineType: 'dialogue' | 'narration') {
  return render(<VoiceLineCard
    line={{ ...narrationLine, lineType }}
    isVoiceTaskRunning={false}
    statusState={null}
    isPlaying={false}
    hasVoice={false}
    onTogglePlay={vi.fn()}
    onDownload={vi.fn()}
    onGenerate={vi.fn()}
    onEdit={vi.fn()}
    onLocatePanel={vi.fn()}
    onDelete={vi.fn()}
    onDeleteAudio={vi.fn()}
    onSaveEmotionSettings={vi.fn()}
  />)
}

describe('narration voice-line identity UI', () => {
  it('labels narration and hides only the delete-line action', () => {
    const view = renderCard('narration')

    expect(view.getByTestId('voice-line-narration-badge').textContent).toBe('Narration')
    expect(view.getByTitle('Edit line')).toBeTruthy()
    expect(view.queryByTitle('Delete line')).toBeNull()
  })

  it('keeps deletion available for dialogue lines', () => {
    const view = renderCard('dialogue')
    expect(view.queryByTestId('voice-line-narration-badge')).toBeNull()
    expect(view.getByTitle('Delete line')).toBeTruthy()
  })

  it('keeps narration content editable while locking speaker and shot identity', () => {
    const noop = vi.fn()
    const view = render(<VoiceControlPanel
      embedded={false}
      analyzing={false}
      isBatchSubmittingAll={false}
      isDownloading={false}
      runningLineCount={0}
      allSpeakersHaveVoice={false}
      totalLines={1}
      linesWithVoice={0}
      linesWithAudio={0}
      speakers={[]}
      speakerStats={{}}
      isLineEditorOpen
      isSavingLineEditor={false}
      editingLineId="narration-1"
      editingLineType="narration"
      editingContent="Years later, she returned."
      editingSpeaker="Narrator"
      editingMatchedPanelId="panel-1"
      speakerOptions={['Narrator']}
      bindablePanelOptions={[{ id: 'panel-1', storyboardId: 'storyboard-1', panelIndex: 0, label: 'Shot 1' }]}
      savingLineEditorState={null}
      onAnalyze={noop}
      onGenerateAll={noop}
      onDownloadAll={noop}
      onStartAdd={noop}
      onOpenAssetLibraryForSpeaker={noop}
      onCancelEdit={noop}
      onSaveEdit={noop}
      onEditingContentChange={noop}
      onEditingSpeakerChange={noop}
      onEditingMatchedPanelIdChange={noop}
      getSpeakerVoiceUrl={() => null}
    >
      <div />
    </VoiceControlPanel>)

    expect(view.getByRole('textbox')).not.toBeDisabled()
    for (const select of view.getAllByRole('combobox')) {
      expect(select).toBeDisabled()
    }
    expect(view.getByText('Identity managed in storyboard')).toBeTruthy()
  })
})
