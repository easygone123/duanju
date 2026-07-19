import { describe, expect, it, vi } from 'vitest'

import {
  analyzeFourGridSheet,
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

describe('four-grid sheet analysis', () => {
  it('sorts exactly four grounded rows by panel number', () => {
    expect(parseFourGridSheetAnalysis(JSON.stringify({ panels: [...rows].reverse() })))
      .toEqual(rows)
  })

  it.each([
    ['missing panel', rows.slice(0, 3)],
    ['duplicate panel', [...rows.slice(0, 3), { ...rows[2] }]],
    ['empty prompt', rows.map((row, index) => index === 0 ? { ...row, video_prompt: '' } : row)],
    ['invalid duration', rows.map((row, index) => index === 0 ? { ...row, duration: 0 } : row)],
  ])('rejects %s', (_case, value) => {
    expect(() => parseFourGridSheetAnalysis(JSON.stringify({ panels: value })))
      .toThrow('FOUR_GRID_SHEET_ANALYSIS_INVALID')
  })

  it('sends the complete sheet and authoritative plot plan to one vision request', async () => {
    const runVision = vi.fn(async () => ({ text: JSON.stringify({ panels: rows }) }))
    const result = await analyzeFourGridSheet({
      userId: 'user-1',
      projectId: 'project-1',
      model: 'openai::vision-model',
      imageDataUrl: 'data:image/png;base64,c2hlZXQ=',
      locale: 'zh',
      panels: rows.map((row, panelIndex) => ({
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
        dialogueSpeaker: 'hero',
        dialogueText: `dialogue ${panelIndex + 1}`,
        dialogueEmotion: 'calm',
        duration: row.duration,
        estimatedDuration: row.duration,
      })),
    }, { runVision: runVision as never })

    expect(result).toEqual(rows)
    expect(runVision).toHaveBeenCalledOnce()
    expect(runVision).toHaveBeenCalledWith(expect.objectContaining({
      imageUrls: ['data:image/png;base64,c2hlZXQ='],
      prompt: expect.stringContaining('planned plot 1'),
    }))
  })
})
