import { describe, expect, it } from 'vitest'

import {
  parseViralAnalysisReport,
  parseViralStoryboardGeneration,
} from '@/lib/viral-replication/contracts'
import {
  VIRAL_ANALYSIS_BATCH_SIZE,
  VIRAL_MAX_ANALYSIS_FRAMES,
  VIRAL_REPLICATION_STATUSES,
  VIRAL_UPLOAD_MAX_BYTES,
  VIRAL_VIDEO_MAX_DURATION_MS,
  VIRAL_VIDEO_MIN_DURATION_MS,
} from '@/lib/viral-replication/constants'

const validReport = () => ({
  schemaVersion: 1,
  overview: {
    hook: 'A surprising first image',
    coreAppeal: 'Fast visual transformation',
    pacing: 'Rapid opening followed by a measured reveal',
    emotionalArc: 'Curiosity to anticipation to delight',
  },
  styleFingerprint: {
    composition: ['centered subject'],
    lighting: ['high-key studio light'],
    color: ['warm accent palette'],
    editing: ['hard cuts on action'],
  },
  shots: [
    {
      shotIndex: 0,
      startMs: 0,
      endMs: 1_500,
      shotType: 'close-up',
      cameraAngle: 'eye-level',
      cameraMove: 'locked-off',
      composition: 'subject centered in frame',
      actionBeat: 'The unopened package lands on the table.',
      transition: 'hard cut',
      subtitleSummary: null,
      narrativeFunction: 'hook',
    },
    {
      shotIndex: 1,
      startMs: 1_500,
      endMs: 4_000,
      shotType: 'medium shot',
      cameraAngle: 'top-down',
      cameraMove: 'slow push-in',
      composition: 'hands frame the product',
      actionBeat: 'The creator reveals the transformed object.',
      transition: 'match cut',
      subtitleSummary: 'Wait for the reveal',
      narrativeFunction: 'payoff',
    },
  ],
  originalAdaptationAdvice: ['Preserve the reveal rhythm while changing the setting.'],
})

const validGeneration = () => ({
  schemaVersion: 1,
  title: 'The Midnight Parcel',
  synopsis: 'A courier discovers a parcel that changes each time it is opened.',
  novelText: 'At midnight, the parcel began to hum.',
  characters: [
    {
      name: 'Lin',
      description: 'A careful night courier with a dry sense of humor.',
    },
  ],
  storyboards: [
    {
      sequence: 0,
      summary: 'The parcel arrives and creates immediate curiosity.',
      panels: [
        {
          panelIndex: 0,
          durationSeconds: 1.5,
          shotType: 'close-up',
          cameraMove: 'locked-off',
          description: 'A glowing parcel lands on a rain-dark counter.',
          imagePrompt: 'Cinematic close-up of a glowing parcel on a wet counter',
          videoPrompt: 'The parcel lands and emits one soft pulse of light',
          sourceNarrativeFunction: 'hook',
        },
      ],
    },
  ],
})

describe('viral replication constants', () => {
  it('defines the bounded workflow contract', () => {
    expect(VIRAL_REPLICATION_STATUSES).toEqual([
      'uploading',
      'analyzing',
      'review_ready',
      'generating',
      'completed',
      'failed',
    ])
    expect(VIRAL_UPLOAD_MAX_BYTES).toBe(500 * 1024 * 1024)
    expect(VIRAL_VIDEO_MIN_DURATION_MS).toBe(15_000)
    expect(VIRAL_VIDEO_MAX_DURATION_MS).toBe(180_000)
    expect(VIRAL_MAX_ANALYSIS_FRAMES).toBe(72)
    expect(VIRAL_ANALYSIS_BATCH_SIZE).toBe(10)
  })
})

describe('parseViralAnalysisReport', () => {
  it('accepts a valid versioned report', () => {
    expect(parseViralAnalysisReport(validReport(), 4_000)).toEqual(validReport())
  })

  it('rejects reports without shots', () => {
    expect(() => parseViralAnalysisReport({ ...validReport(), shots: [] }, 4_000)).toThrow()
  })

  it('rejects non-continuous zero-based shot indexes', () => {
    const report = validReport()
    report.shots[1].shotIndex = 2

    expect(() => parseViralAnalysisReport(report, 4_000)).toThrow(/shotIndex/)
  })

  it('rejects shot end times beyond the source duration', () => {
    const report = validReport()
    report.shots[1].endMs = 4_001

    expect(() => parseViralAnalysisReport(report, 4_000)).toThrow(/duration/i)
  })

  it.each([
    ['a negative start', -1, 1_500],
    ['an empty time range', 1_500, 1_500],
    ['a reversed time range', 2_000, 1_500],
  ])('rejects %s', (_label, startMs, endMs) => {
    const report = validReport()
    report.shots[0].startMs = startMs
    report.shots[0].endMs = endMs

    expect(() => parseViralAnalysisReport(report, 4_000)).toThrow()
  })

  it('rejects a timeline that moves backward', () => {
    const report = validReport()
    report.shots[1].startMs = 1_000

    expect(() => parseViralAnalysisReport(report, 4_000)).toThrow(/timeline/i)
  })

  it('rejects unsupported schema versions and unknown fields', () => {
    expect(() =>
      parseViralAnalysisReport({ ...validReport(), schemaVersion: 2 }, 4_000),
    ).toThrow()
    expect(() =>
      parseViralAnalysisReport({ ...validReport(), unversionedField: true }, 4_000),
    ).toThrow()
  })

  it('rejects excessive text and arrays', () => {
    const excessiveText = validReport()
    excessiveText.overview.hook = 'x'.repeat(100_001)
    expect(() => parseViralAnalysisReport(excessiveText, 4_000)).toThrow()

    const excessiveShots = validReport()
    excessiveShots.shots = Array.from({ length: VIRAL_MAX_ANALYSIS_FRAMES + 1 }, (_, shotIndex) => ({
      ...excessiveShots.shots[0],
      shotIndex,
      startMs: shotIndex,
      endMs: shotIndex + 1,
    }))
    expect(() => parseViralAnalysisReport(excessiveShots, 10_000)).toThrow()
  })
})

describe('parseViralStoryboardGeneration', () => {
  it('accepts a valid versioned generation payload', () => {
    expect(parseViralStoryboardGeneration(validGeneration())).toEqual(validGeneration())
  })

  it('rejects unsupported schema versions and unknown fields', () => {
    expect(() =>
      parseViralStoryboardGeneration({ ...validGeneration(), schemaVersion: 2 }),
    ).toThrow()
    expect(() =>
      parseViralStoryboardGeneration({ ...validGeneration(), unversionedField: true }),
    ).toThrow()
  })

  it('rejects empty storyboards and empty panel lists', () => {
    expect(() =>
      parseViralStoryboardGeneration({ ...validGeneration(), storyboards: [] }),
    ).toThrow()

    const generation = validGeneration()
    generation.storyboards[0].panels = []
    expect(() => parseViralStoryboardGeneration(generation)).toThrow()
  })

  it.each([0, -1])('rejects non-positive panel duration %s', (durationSeconds) => {
    const generation = validGeneration()
    generation.storyboards[0].panels[0].durationSeconds = durationSeconds

    expect(() => parseViralStoryboardGeneration(generation)).toThrow()
  })

  it('rejects non-continuous zero-based storyboard sequences', () => {
    const generation = validGeneration()
    generation.storyboards[0].sequence = 1

    expect(() => parseViralStoryboardGeneration(generation)).toThrow(/sequence/)
  })

  it('rejects non-continuous zero-based panel indexes within a storyboard', () => {
    const generation = validGeneration()
    generation.storyboards[0].panels[0].panelIndex = 1

    expect(() => parseViralStoryboardGeneration(generation)).toThrow(/panelIndex/)
  })

  it('rejects excessive text and arrays', () => {
    const excessiveText = validGeneration()
    excessiveText.novelText = 'x'.repeat(100_001)
    expect(() => parseViralStoryboardGeneration(excessiveText)).toThrow()

    const excessiveCharacters = validGeneration()
    excessiveCharacters.characters = Array.from({ length: 1_001 }, () => ({
      name: 'Character',
      description: 'Description',
    }))
    expect(() => parseViralStoryboardGeneration(excessiveCharacters)).toThrow()
  })
})
