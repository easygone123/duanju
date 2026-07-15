import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ViralReplicationRuntimeHealth = {
  available: boolean
  ffmpeg: boolean
  ffprobe: boolean
}

async function commandAvailable(command: 'ffmpeg' | 'ffprobe'): Promise<boolean> {
  try {
    await execFileAsync(command, ['-version'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    })
    return true
  } catch {
    return false
  }
}

let cachedHealth: Promise<ViralReplicationRuntimeHealth> | null = null

export function getViralReplicationRuntimeHealth(): Promise<ViralReplicationRuntimeHealth> {
  cachedHealth ??= Promise.all([
    commandAvailable('ffmpeg'),
    commandAvailable('ffprobe'),
  ]).then(([ffmpeg, ffprobe]) => ({
    available: ffmpeg && ffprobe,
    ffmpeg,
    ffprobe,
  }))
  return cachedHealth
}
