export interface ViralAudioCue {
  startMs: number
  endMs: number
  text: string
}

const SRT_TIMESTAMP = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/
export const VIRAL_TRANSCRIPT_GAP_THRESHOLD_MS = 5_000
export const VIRAL_AUDIO_TRANSCRIPTION_CHUNK_MS = 30_000

export interface ViralAudioRange {
  startMs: number
  endMs: number
}

function parseTimestamp(value: string): number | null {
  const match = value.match(SRT_TIMESTAMP)
  if (!match) return null
  const [, hours, minutes, seconds, milliseconds] = match
  const valueMs = (
    Number(hours) * 60 * 60 * 1_000
    + Number(minutes) * 60 * 1_000
    + Number(seconds) * 1_000
    + Number(milliseconds.padEnd(3, '0').slice(0, 3))
  )
  return Number.isSafeInteger(valueMs) && valueMs >= 0 ? valueMs : null
}

function formatTimestamp(timestampMs: number): string {
  const hours = Math.floor(timestampMs / 3_600_000)
  const minutes = Math.floor((timestampMs % 3_600_000) / 60_000)
  const seconds = Math.floor((timestampMs % 60_000) / 1_000)
  const milliseconds = timestampMs % 1_000
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':') + `,${String(milliseconds).padStart(3, '0')}`
}

function normalizeCueText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function cuesOverlap(left: ViralAudioCue, right: ViralAudioCue): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs
}

export function serializeViralAudioCues(
  cues: readonly ViralAudioCue[],
  durationMs: number,
): string | null {
  const valid = cues
    .filter((cue) =>
      Number.isSafeInteger(cue.startMs)
      && Number.isSafeInteger(cue.endMs)
      && cue.startMs >= 0
      && cue.startMs < cue.endMs
      && cue.startMs < durationMs
      && cue.text.trim(),
    )
    .map((cue) => ({
      ...cue,
      endMs: Math.min(cue.endMs, durationMs),
      text: cue.text.trim(),
    }))
    .filter((cue) => cue.startMs < cue.endMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  if (valid.length === 0) return null
  return valid.map((cue, index) => [
    String(index + 1),
    `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
    cue.text,
  ].join('\n')).join('\n\n')
}

/**
 * FFmpeg emits embedded text subtitles as SRT. Parse only timestamped blocks so
 * model-generated visuals can follow the original audio without allowing an LLM
 * to rewrite the spoken content or its timing.
 */
export function parseViralAudioCues(transcriptText: string | null | undefined): ViralAudioCue[] {
  if (!transcriptText?.trim()) return []

  const normalized = transcriptText.replace(/\r\n?/g, '\n').trim()
  const cues: ViralAudioCue[] = []
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim())
    const timingIndex = lines.findIndex((line) => line.includes('-->'))
    if (timingIndex < 0) continue
    const [rawStart, rawEnd] = lines[timingIndex].split('-->', 2)
    const startMs = parseTimestamp(rawStart)
    const endMs = parseTimestamp(rawEnd)
    const text = lines
      .slice(timingIndex + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (startMs === null || endMs === null || startMs >= endMs || !text) continue
    cues.push({ startMs, endMs, text })
  }

  return cues.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
}

export function scoreViralTranscript(transcriptText: string | null | undefined): {
  cueCount: number
  firstCueMs: number
  lastCueMs: number
  spanMs: number
  coveredMs: number
  textChars: number
} {
  const cues = parseViralAudioCues(transcriptText)
  const firstCueMs = cues[0]?.startMs ?? 0
  const lastCueMs = cues.at(-1)?.endMs ?? 0
  let coveredUntilMs = 0
  let coveredMs = 0
  for (const cue of cues) {
    const uncoveredStartMs = Math.max(coveredUntilMs, cue.startMs)
    if (cue.endMs > uncoveredStartMs) coveredMs += cue.endMs - uncoveredStartMs
    coveredUntilMs = Math.max(coveredUntilMs, cue.endMs)
  }
  return {
    cueCount: cues.length,
    firstCueMs,
    lastCueMs,
    spanMs: Math.max(0, lastCueMs - firstCueMs),
    coveredMs,
    textChars: cues.reduce((total, cue) => total + cue.text.length, 0),
  }
}

/**
 * Finds only material holes in a subtitle timeline. Short pauses are assumed to
 * be natural silence, so a complete embedded track does not trigger a duplicate
 * full-audio transcription.
 */
export function findViralTranscriptGaps(
  transcriptText: string | null | undefined,
  durationMs: number,
  minimumGapMs = VIRAL_TRANSCRIPT_GAP_THRESHOLD_MS,
): ViralAudioRange[] {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return []
  const cues = parseViralAudioCues(transcriptText)
    .filter((cue) => cue.startMs < durationMs && cue.endMs > 0)
    .map((cue) => ({
      ...cue,
      startMs: Math.max(0, cue.startMs),
      endMs: Math.min(durationMs, cue.endMs),
    }))
  if (cues.length === 0) return [{ startMs: 0, endMs: durationMs }]

  const gaps: ViralAudioRange[] = []
  let coveredUntilMs = 0
  for (const cue of cues) {
    if (cue.startMs - coveredUntilMs >= minimumGapMs) {
      gaps.push({ startMs: coveredUntilMs, endMs: cue.startMs })
    }
    coveredUntilMs = Math.max(coveredUntilMs, cue.endMs)
  }
  if (durationMs - coveredUntilMs >= minimumGapMs) {
    gaps.push({ startMs: coveredUntilMs, endMs: durationMs })
  }
  return gaps
}

export function chunkViralAudioRanges(
  ranges: readonly ViralAudioRange[],
  maximumChunkMs = VIRAL_AUDIO_TRANSCRIPTION_CHUNK_MS,
): ViralAudioRange[] {
  if (!Number.isSafeInteger(maximumChunkMs) || maximumChunkMs <= 0) {
    throw new TypeError('maximumChunkMs must be a positive safe integer')
  }
  const chunks: ViralAudioRange[] = []
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.startMs)
      || !Number.isSafeInteger(range.endMs)
      || range.startMs < 0
      || range.startMs >= range.endMs
    ) continue
    for (let startMs = range.startMs; startMs < range.endMs; startMs += maximumChunkMs) {
      chunks.push({
        startMs,
        endMs: Math.min(range.endMs, startMs + maximumChunkMs),
      })
    }
  }
  return chunks
}

/**
 * Embedded subtitles are authoritative. Supplemental ASR/OCR cues are admitted
 * only where they do not conflict with an embedded cue; identical overlaps are
 * deduplicated.
 */
export function mergeViralAudioTranscripts(input: {
  primaryTranscript: string | null | undefined
  supplementalTranscripts: Array<string | null | undefined>
  durationMs: number
}): string | null {
  const primaryCues = parseViralAudioCues(input.primaryTranscript)
  const merged = [...primaryCues]
  for (const transcript of input.supplementalTranscripts) {
    for (const cue of parseViralAudioCues(transcript)) {
      const normalized = normalizeCueText(cue.text)
      const duplicate = merged.some((existing) =>
        cuesOverlap(existing, cue) && normalizeCueText(existing.text) === normalized,
      )
      if (duplicate) continue
      const conflictsWithPrimary = primaryCues.some((existing) => cuesOverlap(existing, cue))
      if (!conflictsWithPrimary) merged.push(cue)
    }
  }
  return serializeViralAudioCues(merged, input.durationMs)
}

export function audioTextForRange(
  cues: readonly ViralAudioCue[],
  startMs: number,
  endMs: number,
): string | null {
  const text = cues
    .filter((cue) => cue.startMs < endMs && cue.endMs > startMs)
    .map((cue) => cue.text)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join('\n')
    .trim()
  return text || null
}
