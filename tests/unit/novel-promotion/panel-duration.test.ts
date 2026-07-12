import { describe, expect, it } from 'vitest'
import {
  PANEL_DURATION_FORMULA,
  VIDEO_DURATION_INVALID,
  VIDEO_DURATION_TOO_SHORT,
  estimatePanelDuration,
  resolveSupportedDuration,
} from '@/lib/novel-promotion/six-grid/duration'

describe('panel duration estimation', () => {
  it('never decreases as action or camera complexity increases', () => {
    const simple = estimatePanelDuration({ actionComplexity: 0, cameraComplexity: 0 })
    const action = estimatePanelDuration({ actionComplexity: 3, cameraComplexity: 0 })
    const actionAndCamera = estimatePanelDuration({ actionComplexity: 3, cameraComplexity: 3 })

    expect(action.estimatedDuration).toBeGreaterThanOrEqual(simple.estimatedDuration)
    expect(actionAndCamera.estimatedDuration).toBeGreaterThanOrEqual(action.estimatedDuration)
  })

  it('never decreases as dialogue grows and covers action time', () => {
    const short = estimatePanelDuration({
      dialogueText: '等等',
      actionComplexity: 1,
      cameraComplexity: 1,
    })
    const long = estimatePanelDuration({
      dialogueText: '等等，不要离开这里，我们必须马上一起回去。',
      actionComplexity: 1,
      cameraComplexity: 1,
    })
    const actionHeavy = estimatePanelDuration({
      dialogueText: '等等',
      actionComplexity: 8,
      cameraComplexity: 8,
    })

    expect(long.estimatedDuration).toBeGreaterThanOrEqual(short.estimatedDuration)
    expect(actionHeavy.estimatedDuration).toBeGreaterThan(short.estimatedDuration)
  })

  it('keeps the override separate from the deterministic estimate', () => {
    const baseline = estimatePanelDuration({ actionComplexity: 2, cameraComplexity: 2 })
    const overridden = estimatePanelDuration({
      actionComplexity: 2,
      cameraComplexity: 2,
      durationOverride: 9,
    })
    expect(overridden.estimatedDuration).toBe(baseline.estimatedDuration)
    expect(overridden.durationOverride).toBe(9)
    expect(baseline.durationOverride).toBeNull()
  })

  it('clamps estimates to stable minimum and maximum bounds', () => {
    expect(estimatePanelDuration({}).estimatedDuration).toBe(2)
    expect(estimatePanelDuration({
      dialogueText: '很长'.repeat(1000),
      actionComplexity: 100,
      cameraComplexity: 100,
    }).estimatedDuration).toBe(15)
  })

  it('uses the published action/camera coefficients and tenth-second rounding', () => {
    expect(PANEL_DURATION_FORMULA).toMatchObject({
      minimumSeconds: 2,
      actionSecondsPerPoint: 0.65,
      cameraSecondsPerPoint: 0.45,
    })
    expect(estimatePanelDuration({
      actionComplexity: 2,
      cameraComplexity: 3,
    }).estimatedDuration).toBe(4.7)
  })

  it.each([
    ['English', 'Go now', 2.1],
    ['Chinese', '请马上离开这里', 2.6],
  ])('locks the %s readable-character timing formula', (_locale, dialogueText, expected) => {
    expect(estimatePanelDuration({ dialogueText }).estimatedDuration).toBe(expected)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid override %s',
    (durationOverride) => {
      expect(() => estimatePanelDuration({ durationOverride })).toThrow(VIDEO_DURATION_INVALID)
    },
  )
})

describe('fixed provider duration resolution', () => {
  it('chooses the first supported duration that is not shorter', () => {
    expect(resolveSupportedDuration(7.2, [5, 10])).toBe(10)
  })

  it('rejects a request longer than the provider maximum', () => {
    expect(() => resolveSupportedDuration(12, [5, 10])).toThrow(VIDEO_DURATION_TOO_SHORT)
  })

  it('sorts and deduplicates provider durations', () => {
    expect(resolveSupportedDuration(5, [10, 5, 10, 7.5, 5])).toBe(5)
    expect(resolveSupportedDuration(6, [10, 5, 10, 7.5, 5])).toBe(7.5)
  })

  it.each([
    [0, [5, 10]],
    [-1, [5, 10]],
    [Number.NaN, [5, 10]],
    [5, []],
    [5, [0, 10]],
    [5, [Number.POSITIVE_INFINITY]],
  ])('rejects invalid requested or supported durations', (requested, supported) => {
    expect(() => resolveSupportedDuration(requested, supported)).toThrow(VIDEO_DURATION_INVALID)
  })
})
