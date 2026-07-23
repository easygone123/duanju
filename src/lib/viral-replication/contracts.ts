import { z } from 'zod'

import { VIRAL_MAX_ANALYSIS_FRAMES, VIRAL_MAX_GENERATED_PANELS } from './constants'
import { audioTextForRange, parseViralAudioCues } from './audio-timeline'

const shortText = z.string().min(1).max(200)
const mediumText = z.string().min(1).max(2_000)
const longText = z.string().min(1).max(100_000)
const fingerprintValues = z.array(shortText).max(24)
const maxCharacters = 100
const maxStoryboards = 24
const maxPanelsPerStoryboard = 24

const viralAnalysisShotV1Schema = z
  .object({
    shotIndex: z.number().int().nonnegative(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    shotType: shortText,
    cameraAngle: shortText,
    cameraMove: shortText,
    composition: mediumText,
    actionBeat: mediumText,
    transition: shortText,
    subtitleSummary: mediumText.nullable(),
    narrativeFunction: mediumText,
  })
  .strict()

const viralAnalysisReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    overview: z
      .object({
        hook: mediumText,
        coreAppeal: mediumText,
        pacing: mediumText,
        emotionalArc: mediumText,
      })
      .strict(),
    styleFingerprint: z
      .object({
        composition: fingerprintValues,
        lighting: fingerprintValues,
        color: fingerprintValues,
        editing: fingerprintValues,
      })
      .strict(),
    shots: z.array(viralAnalysisShotV1Schema).min(1).max(VIRAL_MAX_ANALYSIS_FRAMES),
    originalAdaptationAdvice: z.array(mediumText).max(24),
  })
  .strict()

export type ViralAnalysisReportV1 = z.infer<typeof viralAnalysisReportV1Schema>

const viralStoryboardPanelV1Schema = z
  .object({
    panelIndex: z.number().int().nonnegative(),
    sourceShotIndex: z.number().int().nonnegative().default(0),
    startMs: z.number().int().nonnegative().default(0),
    endMs: z.number().int().positive().default(1),
    durationSeconds: z.number().finite().positive().max(180),
    shotType: shortText,
    cameraMove: shortText,
    location: shortText.default('未指定场景'),
    characters: z.array(shortText).max(20).default([]),
    audioText: mediumText.nullable().default(null),
    description: mediumText,
    imagePrompt: mediumText,
    videoPrompt: mediumText,
    sourceNarrativeFunction: mediumText,
  })
  .strict()

const viralStoryboardV1Schema = z
  .object({
    sequence: z.number().int().nonnegative(),
    summary: mediumText,
    panels: z.array(viralStoryboardPanelV1Schema).min(1).max(maxPanelsPerStoryboard),
  })
  .strict()

const viralStoryboardGenerationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    title: shortText,
    synopsis: mediumText,
    novelText: longText,
    characters: z
      .array(
        z
          .object({
            name: shortText,
            description: mediumText,
          })
          .strict(),
      )
      .max(maxCharacters),
    locations: z
      .array(
        z
          .object({
            name: shortText,
            description: mediumText,
          })
          .strict(),
      )
      .max(100)
      .default([]),
    storyboards: z.array(viralStoryboardV1Schema).min(1).max(maxStoryboards),
  })
  .strict()

export type ViralStoryboardGenerationV1 = z.infer<typeof viralStoryboardGenerationV1Schema>

function throwValidationIssue(path: Array<string | number>, message: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path,
      message,
    },
  ])
}

export function parseViralAnalysisReport(
  value: unknown,
  durationMs: number,
): ViralAnalysisReportV1 {
  const report = viralAnalysisReportV1Schema.parse(value)
  const parsedDurationMs = z.number().int().positive().parse(durationMs)

  report.shots.forEach((shot, index) => {
    if (shot.shotIndex !== index) {
      throwValidationIssue(
        ['shots', index, 'shotIndex'],
        `shots[${index}].shotIndex must be ${index}`,
      )
    }
    if (shot.startMs >= shot.endMs) {
      throwValidationIssue(
        ['shots', index, 'endMs'],
        `shots[${index}] must satisfy startMs < endMs`,
      )
    }
    if (shot.endMs > parsedDurationMs) {
      throwValidationIssue(
        ['shots', index, 'endMs'],
        `shots[${index}].endMs must not exceed source duration`,
      )
    }
    if (index > 0 && shot.startMs < report.shots[index - 1].endMs) {
      throwValidationIssue(
        ['shots', index, 'startMs'],
        `shots[${index}] must follow nondecreasing timeline order`,
      )
    }
  })

  return report
}

export function parseViralStoryboardGeneration(
  value: unknown,
  timeline?: {
    report: ViralAnalysisReportV1
    transcriptText?: string | null
  },
): ViralStoryboardGenerationV1 {
  const parsedGeneration = viralStoryboardGenerationV1Schema.parse(value)
  // Array order is canonical. Models commonly continue panel numbering across
  // storyboard groups (or use one-based numbering), which should not make an
  // otherwise valid generation fail. Normalize these derived indexes before
  // persistence so every storyboard has stable zero-based local panel indexes.
  let globalPanelIndex = 0
  const generation: ViralStoryboardGenerationV1 = {
    ...parsedGeneration,
    storyboards: parsedGeneration.storyboards.map((storyboard, storyboardIndex) => ({
      ...storyboard,
      sequence: storyboardIndex,
      panels: storyboard.panels.map((panel, panelIndex) => ({
        ...panel,
        panelIndex,
        sourceShotIndex: globalPanelIndex++,
      })),
    })),
  }

  const panelCount = generation.storyboards.reduce(
    (total, storyboard) => total + storyboard.panels.length,
    0,
  )
  if (panelCount > VIRAL_MAX_GENERATED_PANELS) {
    throwValidationIssue(
      ['storyboards'],
      `generated panel count must not exceed ${VIRAL_MAX_GENERATED_PANELS}`,
    )
  }

  if (timeline) {
    const panels = generation.storyboards.flatMap((storyboard) => storyboard.panels)
    if (panels.length !== timeline.report.shots.length) {
      throwValidationIssue(
        ['storyboards'],
        'generated panels must map one-to-one to the source audio shot timeline',
      )
    }
    const cues = parseViralAudioCues(timeline.transcriptText)
    const seenShotIndexes = new Set<number>()
    for (const [panelOrder, panel] of panels.entries()) {
      const shot = timeline.report.shots[panel.sourceShotIndex]
      if (!shot || seenShotIndexes.has(panel.sourceShotIndex) || panel.sourceShotIndex !== panelOrder) {
        throwValidationIssue(
          ['storyboards', panel.sourceShotIndex],
          'sourceShotIndex values must be unique, contiguous, and follow source timeline order',
        )
      }
      seenShotIndexes.add(panel.sourceShotIndex)
      panel.startMs = shot.startMs
      panel.endMs = shot.endMs
      panel.durationSeconds = (shot.endMs - shot.startMs) / 1_000
      panel.audioText = audioTextForRange(cues, shot.startMs, shot.endMs)
    }
  }

  return generation
}
