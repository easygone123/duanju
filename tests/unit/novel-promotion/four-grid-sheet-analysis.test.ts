import { describe, expect, it, vi } from 'vitest'

import {
  analyzeFourGridSheet,
  buildFourGridSheetAnalysisPrompt,
  parseFourGridSheetAnalysis,
} from '@/lib/novel-promotion/grid-storyboard/sheet-analysis'

const rows = Array.from({ length: 4 }, (_, index) => ({
  panel_number: index + 1,
  description: `grounded description ${index + 1}`,
  image_prompt: `image prompt ${index + 1}`,
  video_prompt: `video prompt ${index + 1}`,
  duration: index + 1,
  shot_type: '中景',
  camera_move: '固定',
  narration_recommended: false,
  narration_text: null,
  narration_emotion: null,
}))

const plannedPanels = rows.map((row, panelIndex) => ({
  panelIndex,
  description: `planned plot ${panelIndex + 1}`,
  imagePrompt: null,
  videoPrompt: `planned motion ${panelIndex + 1}`,
  shotType: '中景',
  cameraMove: '固定',
  location: 'courtyard',
  characters: '["hero"]',
  props: '[]',
  srtSegment: `line ${panelIndex + 1}`,
  dialogueSpeaker: panelIndex === 0 ? 'hero' : null,
  dialogueText: panelIndex === 0 ? 'dialogue 1' : null,
  dialogueEmotion: panelIndex === 0 ? 'calm' : null,
  duration: row.duration,
  estimatedDuration: row.duration,
}))

function promptExample(prompt: string) {
  const jsonLine = prompt.split('\n').find((line) => line.startsWith('{"panels":'))
  if (!jsonLine) throw new Error('Missing four-grid prompt example')
  return JSON.parse(jsonLine) as {
    panels: Array<{
      panel_number: number
      narration_recommended: boolean
      narration_text: string | null
      narration_emotion: string | null
    }>
  }
}

describe('four-grid sheet analysis', () => {
  it('sorts exactly four grounded rows by panel number', () => {
    expect(parseFourGridSheetAnalysis(JSON.stringify({ panels: [...rows].reverse() }), plannedPanels))
      .toEqual(rows)
  })

  it('accepts recommended narration with text on a dialogue-free panel', () => {
    const narratedRows = rows.map((row, index) => index === 1
      ? {
          ...row,
          narration_recommended: true,
          narration_text: 'Night fell before they reached the city.',
          narration_emotion: 'reflective',
        }
      : row)

    expect(parseFourGridSheetAnalysis(JSON.stringify({ panels: narratedRows }), plannedPanels))
      .toEqual(narratedRows)
  })

  it('binds shuffled model rows to shuffled planned panels by panel number and panel index', () => {
    const narratedRows = rows.map((row, index) => index === 1
      ? {
          ...row,
          narration_recommended: true,
          narration_text: 'Night fell before they reached the city.',
          narration_emotion: 'reflective',
        }
      : row)
    const shuffledPanels = [plannedPanels[2], plannedPanels[3], plannedPanels[0], plannedPanels[1]]
    const shuffledRows = [...narratedRows].reverse()

    expect(shuffledRows[2]).toMatchObject({ panel_number: 2, narration_recommended: true })
    expect(shuffledPanels[2]).toMatchObject({ panelIndex: 0, dialogueText: 'dialogue 1' })

    expect(parseFourGridSheetAnalysis(
      JSON.stringify({ panels: shuffledRows }),
      shuffledPanels,
    )).toEqual(narratedRows)
  })

  it('accepts non-recommended narration fields as null', () => {
    expect(parseFourGridSheetAnalysis(JSON.stringify({ panels: rows }), plannedPanels))
      .toEqual(rows)
  })

  it.each([
    ['missing panel', rows.slice(0, 3)],
    ['duplicate panel', [...rows.slice(0, 3), { ...rows[2] }]],
    ['empty prompt', rows.map((row, index) => index === 0 ? { ...row, video_prompt: '' } : row)],
    ['invalid duration', rows.map((row, index) => index === 0 ? { ...row, duration: 0 } : row)],
  ])('rejects %s', (_case, value) => {
    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value }), plannedPanels))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it.each([
    ['duplicate', plannedPanels.map((panel, index) => (
      index === 3 ? { ...panel, panelIndex: 2 } : panel
    ))],
    ['gapped', plannedPanels.map((panel, index) => (
      index === 3 ? { ...panel, panelIndex: 4 } : panel
    ))],
  ])('rejects %s planned panel indexes', (_case, value) => {
    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: rows }), value))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it('rejects narration recommended on a panel with authoritative dialogue', () => {
    const value = rows.map((row, index) => index === 0
      ? { ...row, narration_recommended: true, narration_text: 'Narration over dialogue.' }
      : row)

    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value }), plannedPanels))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it.each([
    ['null', null],
    ['blank', '   '],
  ])('rejects recommended narration with %s text', (_case, narrationText) => {
    const value = rows.map((row, index) => index === 1
      ? { ...row, narration_recommended: true, narration_text: narrationText }
      : row)

    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value }), plannedPanels))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it('rejects narration text when narration is not recommended', () => {
    const value = rows.map((row, index) => index === 1
      ? { ...row, narration_text: 'Unexpected narration.' }
      : row)

    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value }), plannedPanels))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it('rejects narration emotion when narration is not recommended', () => {
    const value = rows.map((row, index) => index === 1
      ? { ...row, narration_emotion: 'somber' }
      : row)

    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value }), plannedPanels))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it('instructs narration eligibility, nonredundancy, and duration allocation', () => {
    const prompt = buildFourGridSheetAnalysisPrompt({ locale: 'en', panels: plannedPanels })

    expect(prompt).toContain('Narration is allowed only on panels whose authoritative dialogue is empty')
    expect(prompt).toContain('time/location transition, inner thought, off-screen background information, or necessary causal context')
    expect(prompt).toContain('Never use narration to restate visible action')
    expect(prompt).toContain('Include narration speaking time in duration allocation')
    expect(prompt).toContain('Evaluate every eligible dialogue-free panel independently')
    expect(prompt).toContain('never default all eligible panels to narration_recommended false')
    expect(prompt).toContain('"narration_recommended":true,"narration_text":"Time passed before they reached the city.","narration_emotion":"reflective"')
    expect(prompt.match(/"narration_recommended":false,"narration_text":null,"narration_emotion":null/g))
      .toHaveLength(3)
  })

  it('keeps numbered prompt examples narration-free on dialogue panels', () => {
    const panelsWithPanelTwoDialogue = plannedPanels.map((panel, index) => index === 1
      ? {
          ...panel,
          dialogueSpeaker: 'hero',
          dialogueText: 'dialogue 2',
          dialogueEmotion: 'calm',
        }
      : panel)
    const example = promptExample(buildFourGridSheetAnalysisPrompt({
      locale: 'en',
      panels: panelsWithPanelTwoDialogue,
    }))

    for (const panel of panelsWithPanelTwoDialogue.filter((panel) => panel.dialogueText?.trim())) {
      expect(example.panels.find((row) => row.panel_number === panel.panelIndex + 1))
        .toMatchObject({
          narration_recommended: false,
          narration_text: null,
          narration_emotion: null,
        })
    }
  })

  it('keeps all numbered prompt examples non-narrated when every panel has dialogue', () => {
    const allDialoguePanels = plannedPanels.map((panel, index) => ({
      ...panel,
      dialogueSpeaker: 'hero',
      dialogueText: `dialogue ${index + 1}`,
      dialogueEmotion: 'calm',
    }))
    const prompt = buildFourGridSheetAnalysisPrompt({ locale: 'en', panels: allDialoguePanels })
    const example = promptExample(prompt)

    expect(example.panels).toHaveLength(4)
    expect(example.panels.every((row) => !row.narration_recommended
      && row.narration_text === null
      && row.narration_emotion === null)).toBe(true)
    expect(prompt).toContain('Eligible-panel true branch semantics (not a numbered panel recommendation)')
    expect(prompt).toContain('"narration_recommended":true,"narration_text":"Time passed before they reached the city.","narration_emotion":"reflective"')
  })

  it('sends the complete sheet and authoritative plot plan to one vision request', async () => {
    const runVision = vi.fn(async () => ({ text: JSON.stringify({ panels: rows }) }))
    const result = await analyzeFourGridSheet({
      userId: 'user-1',
      projectId: 'project-1',
      model: 'openai::vision-model',
      imageDataUrl: 'data:image/png;base64,c2hlZXQ=',
      locale: 'zh',
      panels: plannedPanels,
    }, { runVision: runVision as never })

    expect(result).toEqual(rows)
    expect(runVision).toHaveBeenCalledOnce()
    expect(runVision).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: ['data:image/png;base64,c2hlZXQ='],
      prompt: expect.stringContaining('planned plot 1'),
    }))
  })
})
