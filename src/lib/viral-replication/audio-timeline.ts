export interface ViralAudioCue {
  startMs: number
  endMs: number
  text: string
}

const SRT_TIMESTAMP = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

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
