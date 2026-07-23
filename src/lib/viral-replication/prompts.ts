import { z } from 'zod'

import type { Locale } from '@/i18n/routing'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { safeParseJson } from '@/lib/json-repair'
import type { PreprocessedViralShot } from './preprocess'
import type { ViralAnalysisReportV1 } from './contracts'

const analyzedShotSchema = z.object({
  shotIndex: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  shotType: z.string().min(1).max(200),
  cameraAngle: z.string().min(1).max(200),
  cameraMove: z.string().min(1).max(200),
  composition: z.string().min(1).max(2_000),
  actionBeat: z.string().min(1).max(2_000),
  transition: z.string().min(1).max(200),
  subtitleSummary: z.string().min(1).max(2_000).nullable(),
  narrativeFunction: z.string().min(1).max(2_000),
  visibleCharacters: z.array(z.string().min(1).max(200)).max(24),
  speaker: z.string().min(1).max(200).nullable(),
  location: z.string().min(1).max(200).nullable(),
  props: z.array(z.string().min(1).max(200)).max(24),
  dialogueIntent: z.string().min(1).max(2_000).nullable(),
  plotBeat: z.string().min(1).max(2_000).nullable(),
  causalLink: z.string().min(1).max(2_000).nullable(),
  analysisConfidence: z.number().finite().min(0).max(1),
  needsVisualReview: z.boolean(),
}).strict()

const shotBatchSchema = z.object({
  shots: z.array(analyzedShotSchema).min(1).max(10),
}).strict()

export type ViralShotAnalysisBatch = z.infer<typeof shotBatchSchema>

const audioTranscriptSchema = z.object({
  cues: z.array(z.object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: z.string().min(1).max(2_000),
  }).strict()).max(1_000),
}).strict()

export const MAX_VIRAL_TRANSCRIPT_PROMPT_CHARS = 50_000
export const MAX_VIRAL_MODEL_PROMPT_CHARS = 100_000

function truncateUntrustedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[TRUNCATED]`
}

function serializeUntrusted(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    if (character === '<') return '\\u003c'
    if (character === '>') return '\\u003e'
    return '\\u0026'
  })
}

function delimitUntrusted(label: string, value: unknown): string {
  return `<<<BEGIN_UNTRUSTED_${label}>>>\n${serializeUntrusted(value)}\n<<<END_UNTRUSTED_${label}>>>`
}

function assertPromptLength(prompt: string): string {
  if (prompt.length > MAX_VIRAL_MODEL_PROMPT_CHARS) {
    throw new Error(`Viral model prompt length exceeds ${MAX_VIRAL_MODEL_PROMPT_CHARS} characters`)
  }
  return prompt
}

export const VIRAL_REPORT_SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  overview: {
    hook: 'string',
    coreAppeal: 'string',
    pacing: 'string',
    emotionalArc: 'string',
  },
  sourceStory: {
    summary: 'string',
    premise: 'string',
    characterRelations: ['string'],
    storyBeats: [{
      shotIndexes: [0],
      beat: 'string',
      cause: 'string|null',
      effect: 'string|null',
    }],
  },
  styleFingerprint: {
    composition: ['string'],
    lighting: ['string'],
    color: ['string'],
    editing: ['string'],
  },
  shots: [{
    shotIndex: 0,
    startMs: 0,
    endMs: 1000,
    shotType: 'string',
    cameraAngle: 'string',
    cameraMove: 'string',
    composition: 'string',
    actionBeat: 'string',
    transition: 'string',
    subtitleSummary: 'string|null',
    narrativeFunction: 'string',
    visibleCharacters: ['string'],
    speaker: 'string|null',
    location: 'string|null',
    props: ['string'],
    dialogueIntent: 'string|null',
    plotBeat: 'string|null',
    causalLink: 'string|null',
    analysisConfidence: 0.85,
    needsVisualReview: false,
  }],
  originalAdaptationAdvice: ['string'],
})

export const VIRAL_GENERATION_SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  title: 'string',
  synopsis: 'string',
  novelText: 'string',
  characters: [{ name: 'string', description: 'string' }],
  locations: [{ name: 'string', description: 'string' }],
  storyboards: [{
    sequence: 0,
    summary: 'string',
    panels: [{
      panelIndex: 0,
      sourceShotIndex: 0,
      startMs: 0,
      endMs: 2000,
      durationSeconds: 2,
      shotType: 'string',
      cameraMove: 'string',
      location: 'string',
      characters: ['string'],
      audioText: 'string|null',
      description: 'string',
      imagePrompt: 'string',
      videoPrompt: 'string',
      sourceNarrativeFunction: 'string',
    }],
  }],
})

export function buildViralAudioTranscriptionPrompt(input: {
  locale: Locale
  durationMs: number
}): string {
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_AUDIO_TRANSCRIPTION,
    locale: input.locale,
    variables: {
      duration_ms: String(input.durationMs),
    },
  }))
}

function srtTimestamp(timestampMs: number): string {
  const hours = Math.floor(timestampMs / 3_600_000)
  const minutes = Math.floor((timestampMs % 3_600_000) / 60_000)
  const seconds = Math.floor((timestampMs % 60_000) / 1_000)
  const milliseconds = timestampMs % 1_000
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':') + `,${String(milliseconds).padStart(3, '0')}`
}

export function parseViralAudioTranscription(
  completionText: string,
  durationMs: number,
): string | null {
  const parsed = audioTranscriptSchema.parse(safeParseJson(completionText))
  const cues = parsed.cues
    .filter((cue) => cue.startMs < cue.endMs && cue.endMs <= durationMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  if (cues.length === 0) return null
  return cues.map((cue, index) => [
    String(index + 1),
    `${srtTimestamp(cue.startMs)} --> ${srtTimestamp(cue.endMs)}`,
    cue.text.trim(),
  ].join('\n')).join('\n\n')
}

export function buildViralShotAnalysisPrompt(input: {
  locale: Locale
  brief: string
  videoMetadata: Record<string, unknown>
  shots: PreprocessedViralShot[]
  subtitleContext: string | null
  previousShotContext?: ViralShotAnalysisBatch['shots'][number] | null
}): string {
  const subtitleContext = truncateUntrustedText(
    input.subtitleContext || 'None',
    MAX_VIRAL_TRANSCRIPT_PROMPT_CHARS,
  )
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_SHOT_ANALYSIS,
    locale: input.locale,
    variables: {
      brief: delimitUntrusted('BRIEF', input.brief),
      video_metadata: JSON.stringify(input.videoMetadata),
      shot_timeline: JSON.stringify(input.shots.map((shot) => ({
        shotIndex: shot.shotIndex,
        startMs: shot.startMs,
        endMs: shot.endMs,
        representativeMs: shot.representativeMs,
      }))),
      previous_shot_context: delimitUntrusted(
        'PREVIOUS_SHOT_CONTEXT',
        input.previousShotContext ?? null,
      ),
      subtitle_context: delimitUntrusted('SUBTITLE_CONTEXT', subtitleContext),
    },
  }))
}

export function buildViralShotReviewPrompt(input: {
  locale: Locale
  videoMetadata: Record<string, unknown>
  shots: Array<{
    shotIndex: number
    startMs: number
    endMs: number
    frameTimestampsMs: number[]
    transcriptText: string | null
    initialAnalysis: ViralShotAnalysisBatch['shots'][number]
  }>
}): string {
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_SHOT_REVIEW,
    locale: input.locale,
    variables: {
      video_metadata: JSON.stringify(input.videoMetadata),
      review_shots: delimitUntrusted('REVIEW_SHOTS', input.shots),
    },
  }))
}

export function buildViralReportAggregationPrompt(input: {
  locale: Locale
  brief: string
  durationMs: number
  batchResults: ViralShotAnalysisBatch[]
}): string {
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_REPORT_AGGREGATION,
    locale: input.locale,
    variables: {
      brief: delimitUntrusted('BRIEF', input.brief),
      duration_ms: String(input.durationMs),
      batch_results_json: delimitUntrusted(
        'BATCH_RESULTS',
        input.batchResults,
      ),
      report_schema_json: VIRAL_REPORT_SCHEMA_JSON,
    },
  }))
}

export function buildViralStoryboardGenerationPrompt(input: {
  locale: Locale
  brief: string
  videoRatio: string
  artStyle: string
  report: ViralAnalysisReportV1
  transcriptText: string | null
}): string {
  return assertPromptLength(buildPrompt({
    promptId: PROMPT_IDS.VIRAL_STORYBOARD_GENERATION,
    locale: input.locale,
    variables: {
      brief: delimitUntrusted('BRIEF', input.brief),
      video_ratio: input.videoRatio,
      art_style: input.artStyle,
      analysis_report_json: delimitUntrusted('ANALYSIS_REPORT', input.report),
      source_audio_transcript: delimitUntrusted(
        'SOURCE_AUDIO_TRANSCRIPT',
        truncateUntrustedText(
          input.transcriptText || 'No embedded speech transcript is available. Keep the original audio timing and use visual analysis only.',
          MAX_VIRAL_TRANSCRIPT_PROMPT_CHARS,
        ),
      ),
      generation_schema_json: VIRAL_GENERATION_SCHEMA_JSON,
    },
  }))
}

export function parseViralShotAnalysisBatch(
  completionText: string,
  expectedShots: PreprocessedViralShot[],
): ViralShotAnalysisBatch {
  const result = shotBatchSchema.parse(safeParseJson(completionText))
  if (result.shots.length !== expectedShots.length) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['shots'],
      message: `Expected ${expectedShots.length} analyzed shots, received ${result.shots.length}`,
    }])
  }
  result.shots.forEach((shot, index) => {
    const expected = expectedShots[index]
    if (
      !expected
      || shot.shotIndex !== expected.shotIndex
      || shot.startMs !== expected.startMs
      || shot.endMs !== expected.endMs
    ) {
      throw new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: ['shots', index],
        message: 'Analyzed shot identity and timeline must match the requested frame order',
      }])
    }
  })
  return result
}
