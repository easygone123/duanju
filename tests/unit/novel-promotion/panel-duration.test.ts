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
    expect(estimatePanelDuration({}).estimatedDuration).toBe(2.5)
    expect(estimatePanelDuration({
      dialogueText: '很长'.repeat(1000),
      actionComplexity: 100,
      cameraComplexity: 100,
    }).estimatedDuration).toBe(15)
  })

  it('uses the published action/camera coefficients and tenth-second rounding', () => {
    expect(PANEL_DURATION_FORMULA).toMatchObject({
      minimumSeconds: 2.5,
      actionSecondsPerPoint: 0.65,
      cameraSecondsPerPoint: 0.45,
    })
    expect(estimatePanelDuration({
      actionComplexity: 2,
      cameraComplexity: 3,
    }).estimatedDuration).toBe(5.2)
  })

  it.each([
    ['English', 'Go now', 2.5],
    ['Chinese', '请马上离开这里', 3.1],
  ])('uses a natural %s speaking-rate floor', (_locale, dialogueText, expected) => {
    expect(estimatePanelDuration({ dialogueText }).estimatedDuration).toBe(expected)
  })

  it('extracts quoted speech from source text when dialogue metadata is absent', () => {
    const silent = estimatePanelDuration({ description: '角色站在门口' })
    const speaking = estimatePanelDuration({
      description: '角色站在门口说话',
      sourceText: '张三说：「等等，不要离开这里，我们必须马上一起回去。」',
    })

    expect(speaking.estimatedDuration).toBeGreaterThan(silent.estimatedDuration)
    expect(speaking.estimatedDuration).toBeGreaterThan(6)
  })

  it('allocates more time to sequential action and moving-camera shots', () => {
    const staticReaction = estimatePanelDuration({
      description: '李四皱眉看向门口',
      cameraMove: '固定',
    })
    const complexMove = estimatePanelDuration({
      description: '李四站起身，然后转身走向门口，接着伸手推开门并回头点头',
      cameraMove: '镜头跟随，随后缓缓推近',
    })

    expect(complexMove.estimatedDuration).toBeGreaterThan(staticReaction.estimatedDuration + 2)
  })

  it('treats analysis-model duration as authoritative', () => {
    expect(estimatePanelDuration({ plannerDuration: 8 }).estimatedDuration).toBe(8)
    expect(estimatePanelDuration({
      plannerDuration: 2,
      dialogueText: '你先别急着走，我们还有很多事情没有说清楚。',
    }).estimatedDuration).toBe(2)
  })

  it('uses semantic estimation only when the analysis model omitted duration', () => {
    expect(estimatePanelDuration({
      dialogueText: '你先别急着走，我们还有很多事情没有说清楚。',
    }).estimatedDuration).toBeGreaterThan(2)
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
