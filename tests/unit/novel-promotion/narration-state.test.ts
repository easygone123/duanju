import { describe, expect, it } from 'vitest'
import {
  PANEL_NARRATION_MODES,
  parseNarrationMode,
  resolveNarrationContent,
  resolveNarrationEnabled,
  validateManualNarration,
} from '@/lib/novel-promotion/narration/state'

describe('panel narration state', () => {
  it('accepts only the supported modes', () => {
    expect(PANEL_NARRATION_MODES).toEqual(['auto', 'on', 'off'])
    expect(PANEL_NARRATION_MODES.map((mode) => parseNarrationMode(mode)))
      .toEqual(['auto', 'on', 'off'])
    expect(() => parseNarrationMode('invalid')).toThrow('PANEL_NARRATION_MODE_INVALID')
    expect(() => parseNarrationMode(null)).toThrow('PANEL_NARRATION_MODE_INVALID')
  })

  it('resolves enabled state from the mode and recommendation', () => {
    expect(resolveNarrationEnabled({ mode: 'auto', recommended: true })).toBe(true)
    expect(resolveNarrationEnabled({ mode: 'auto', recommended: false })).toBe(false)
    expect(resolveNarrationEnabled({ mode: 'on', recommended: false })).toBe(true)
    expect(resolveNarrationEnabled({ mode: 'off', recommended: true })).toBe(false)
  })

  it('requires usable manual text only when narration is forced on', () => {
    expect(() => validateManualNarration({ mode: 'on', text: '  ' }))
      .toThrow('PANEL_NARRATION_TEXT_REQUIRED')
    expect(() => validateManualNarration({ mode: 'on', text: null }))
      .toThrow('PANEL_NARRATION_TEXT_REQUIRED')
    expect(() => validateManualNarration({ mode: 'on', text: 'Keep moving.' }))
      .not.toThrow()
    expect(() => validateManualNarration({ mode: 'off', text: '  ' })).not.toThrow()
    expect(() => validateManualNarration({ mode: 'auto', text: null })).not.toThrow()
  })

  it('uses suggested content in auto mode', () => {
    expect(resolveNarrationContent({
      mode: 'auto',
      suggestedText: 'Suggested narration',
      suggestedEmotion: 'reflective',
      manualText: 'Manual narration',
      manualEmotion: 'urgent',
    })).toEqual({
      text: 'Suggested narration',
      emotion: 'reflective',
    })
  })

  it.each(['on', 'off'] as const)('uses manual content in %s mode', (mode) => {
    expect(resolveNarrationContent({
      mode,
      suggestedText: 'Suggested narration',
      suggestedEmotion: 'reflective',
      manualText: 'Manual narration',
      manualEmotion: 'urgent',
    })).toEqual({
      text: 'Manual narration',
      emotion: 'urgent',
    })
  })
})
