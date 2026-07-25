import { z } from 'zod'

import { VIRAL_MAX_ANALYSIS_FRAMES, VIRAL_MAX_GENERATED_PANELS } from './constants'
import { audioTextForRange, parseViralAudioCues } from './audio-timeline'

const shortText = z.string().min(1).max(200)
const mediumText = z.string().min(1).max(2_000)
const longText = z.string().min(1).max(100_000)
const fingerprintValues = z.array(shortText).max(24)
const plotTextValues = z.array(shortText).max(24)
const maxCharacters = 100
const maxStoryboards = 24
const maxPanelsPerStoryboard = 24

const viralSourceStoryV1Schema = z
  .object({
    summary: mediumText,
    premise: mediumText,
    characterRelations: z.array(mediumText).max(50),
    storyBeats: z
      .array(
        z
          .object({
            shotIndexes: z.array(z.number().int().nonnegative()).min(1).max(24),
            beat: mediumText,
            cause: mediumText.nullable(),
            effect: mediumText.nullable(),
          })
          .strict(),
      )
      .max(VIRAL_MAX_ANALYSIS_FRAMES),
  })
  .strict()

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
    visibleCharacters: plotTextValues.default([]),
    speaker: shortText.nullable().default(null),
    location: shortText.nullable().default(null),
    props: plotTextValues.default([]),
    dialogueIntent: mediumText.nullable().default(null),
    plotBeat: mediumText.nullable().default(null),
    causalLink: mediumText.nullable().default(null),
    analysisConfidence: z.number().finite().min(0).max(1).default(1),
    needsVisualReview: z.boolean().default(false),
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
    sourceStory: viralSourceStoryV1Schema.nullable().default(null),
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
export type ViralSourceStoryV1 = NonNullable<ViralAnalysisReportV1['sourceStory']>

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

function boundedText(value: string, maximumLength: number): string {
  const normalized = value.trim()
  if (normalized.length <= maximumLength) return normalized
  return normalized.slice(0, maximumLength).trimEnd()
}

function joinBoundedText(values: Array<string | null | undefined>, maximumLength = 2_000): string {
  return boundedText(values.filter((value): value is string => Boolean(value?.trim())).join('\n'), maximumLength)
}

export function deriveViralSourceStoryFromTranscript(
  report: ViralAnalysisReportV1,
  transcriptText: string | null | undefined,
): ViralSourceStoryV1 | null {
  const cues = parseViralAudioCues(transcriptText)
  if (cues.length === 0) return null
  const transcript = joinBoundedText(cues.map((cue) => cue.text))
  if (!transcript) return null

  return {
    summary: transcript,
    premise: boundedText(cues[0]!.text, 2_000),
    characterRelations: [],
    storyBeats: report.shots.map((shot) => ({
      shotIndexes: [shot.shotIndex],
      beat: audioTextForRange(cues, shot.startMs, shot.endMs)
        || shot.plotBeat
        || shot.actionBeat,
      cause: null,
      effect: null,
    })),
  }
}

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
  if (report.sourceStory) {
    const coveredShotIndexes = report.sourceStory.storyBeats.flatMap((beat) => beat.shotIndexes)
    if (
      coveredShotIndexes.length !== report.shots.length
      || coveredShotIndexes.some((shotIndex, index) => shotIndex !== index)
    ) {
      throwValidationIssue(
        ['sourceStory', 'storyBeats'],
        'sourceStory.storyBeats must cover every shot exactly once in timeline order',
      )
    }
  }

  return report
}

export function parseViralStoryboardGeneration(
  value: unknown,
  timeline?: {
    report: ViralAnalysisReportV1
    transcriptText?: string | null
    artStyle?: string | null
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
    if (cues.length > 0) {
      const transcript = cues.map((cue) => cue.text).join('\n')
      generation.title = boundedText(cues[0]!.text, 200)
      generation.synopsis = boundedText(transcript, 2_000)
      generation.novelText = boundedText(transcript, 100_000)
    }
    const characterDesigns = new Map(
      generation.characters.map((character) => [character.name, character.description]),
    )
    const locationDesigns = new Map(
      generation.locations.map((location) => [location.name, location.description]),
    )
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
      panel.shotType = shot.shotType
      panel.cameraMove = shot.cameraMove
      panel.sourceNarrativeFunction = shot.narrativeFunction

      const authoritativePlot = shot.plotBeat || shot.actionBeat
      const audioContract = panel.audioText
        ? `原声台词（逐字保持）：${panel.audioText}`
        : null
      const visualCharacters = panel.characters.map((name) => {
        const design = characterDesigns.get(name)
        return design ? `${name}：${design}` : name
      })
      const locationDesign = locationDesigns.get(panel.location)
      panel.description = joinBoundedText([
        audioContract,
        `原剧情画面事实：${authoritativePlot}`,
      ])
      panel.imagePrompt = joinBoundedText([
        audioContract,
        `必须忠实绘制的原剧情事件：${authoritativePlot}`,
        `镜头：${shot.shotType}，${shot.cameraAngle}，${shot.composition}`,
        locationDesign ? `场景设计：${panel.location}，${locationDesign}` : `场景：${panel.location}`,
        visualCharacters.length > 0 ? `角色设计：${visualCharacters.join('；')}` : null,
        timeline.artStyle?.trim() ? `艺术风格：${timeline.artStyle.trim()}` : null,
        '不得改编剧情、替换事件或改变原声含义。',
      ])
      panel.videoPrompt = joinBoundedText([
        audioContract,
        `在${panel.durationSeconds}秒内与原声音频严格同步表演：${authoritativePlot}`,
        `动作事实：${shot.actionBeat}`,
        `运镜：${shot.cameraMove}`,
        shot.causalLink ? `前后承接：${shot.causalLink}` : null,
        '不得增加字幕和原声中不存在的对白、冲突、动机或结局。',
      ])
    }
    for (const storyboard of generation.storyboards) {
      storyboard.summary = joinBoundedText(storyboard.panels.map((panel) =>
        panel.audioText || timeline.report.shots[panel.sourceShotIndex]?.plotBeat
        || timeline.report.shots[panel.sourceShotIndex]?.actionBeat,
      ))
    }
  }

  return generation
}
