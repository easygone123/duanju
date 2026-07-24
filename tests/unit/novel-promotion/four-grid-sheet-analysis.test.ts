import { describe, expect, it } from 'vitest'

import {
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

describe('four-grid sheet analysis', () => {
  it('sorts exactly four grounded rows by panel number', () => {
    expect(parseFourGridSheetAnalysis(JSON.stringify({ panels: [...rows].reverse() }), plannedPanels))
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

  it('allocates duration from the authoritative plot without inventing voiceover', () => {
    const prompt = buildFourGridSheetAnalysisPrompt({ locale: 'en', panels: plannedPanels })

    expect(prompt).toContain('the returned duration becomes authoritative')
    expect(prompt).toContain('there is no fixed per-panel duration and no required total duration')
    expect(prompt).toContain('Do not invent voiceover or narration')
    expect(prompt).not.toContain('narration_recommended')
    expect(prompt).not.toContain('narration_text')
  })
})
