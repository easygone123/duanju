import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import {
  generateUniqueKey,
  getObjectBuffer,
  uploadObject,
} from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import {
  createCommandRunner,
  type CommandRunner,
} from '@/lib/viral-replication/ffmpeg'
import type { VideoEditorProject, VideoClip } from '@/features/video-editor/types/editor.types'
import type { TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '@/lib/workers/shared'

const MAX_EDITOR_CLIPS = 200
const MAX_DIMENSION = 3840
const MAX_TOTAL_DURATION_SECONDS = 60 * 60
const RENDER_TIMEOUT_MS = 30 * 60 * 1000

type RenderableClip = {
  clip: VideoClip
  videoStorageKey: string
  attachmentAudioStorageKey: string | null
}

type RenderSource = {
  project: VideoEditorProject
  clips: RenderableClip[]
  originalAudioStorageKey: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(1, Math.round(parsed)))
}

export function parseVideoEditorProject(value: unknown): VideoEditorProject {
  const root = asRecord(value)
  const config = asRecord(root?.config)
  const timeline = Array.isArray(root?.timeline) ? root.timeline : []
  const bgmTrack = Array.isArray(root?.bgmTrack) ? root.bgmTrack : []
  if (!root || !root.id || !root.episodeId || timeline.length === 0 || timeline.length > MAX_EDITOR_CLIPS) {
    throw new Error('EDITOR_RENDER_PROJECT_INVALID')
  }

  const fps = positiveInteger(config?.fps, 30, 60)
  const width = positiveInteger(config?.width, 1920, MAX_DIMENSION)
  const height = positiveInteger(config?.height, 1080, MAX_DIMENSION)
  const clips: VideoClip[] = timeline.map((raw, index) => {
    const clip = asRecord(raw)
    const metadata = asRecord(clip?.metadata)
    const id = typeof clip?.id === 'string' ? clip.id : ''
    const panelId = typeof metadata?.panelId === 'string' ? metadata.panelId : ''
    const storyboardId = typeof metadata?.storyboardId === 'string' ? metadata.storyboardId : ''
    const durationInFrames = positiveInteger(clip?.durationInFrames, 1, fps * 60 * 10)
    if (!clip || !metadata || !id || !panelId || !storyboardId) {
      throw new Error(`EDITOR_RENDER_CLIP_INVALID:${index}`)
    }
    return {
      ...(clip as unknown as VideoClip),
      id,
      durationInFrames,
      metadata: {
        ...(metadata as unknown as VideoClip['metadata']),
        panelId,
        storyboardId,
      },
    }
  })

  const totalDuration = clips.reduce((sum, clip) => sum + clip.durationInFrames / fps, 0)
  if (totalDuration > MAX_TOTAL_DURATION_SECONDS) throw new Error('EDITOR_RENDER_DURATION_TOO_LONG')

  return {
    ...(root as unknown as VideoEditorProject),
    config: { fps, width: width - (width % 2), height: height - (height % 2) },
    timeline: clips,
    bgmTrack: bgmTrack as VideoEditorProject['bgmTrack'],
  }
}

async function materializeStorageObject(storageKey: string, targetPath: string) {
  const bytes = await getObjectBuffer(storageKey)
  if (bytes.length === 0) throw new Error('EDITOR_RENDER_MEDIA_EMPTY')
  await fs.writeFile(targetPath, bytes)
}

async function resolveRenderSource(input: {
  editorProjectId: string
  projectId: string
  userId: string
}): Promise<RenderSource> {
  const editor = await prisma.videoEditorProject.findFirst({
    where: {
      id: input.editorProjectId,
      episode: {
        novelPromotionProject: {
          projectId: input.projectId,
          project: { userId: input.userId },
        },
      },
    },
    include: {
      episode: {
        include: { audioMedia: true },
      },
    },
  })
  if (!editor) throw new Error('EDITOR_RENDER_PROJECT_NOT_FOUND')

  const project = parseVideoEditorProject(JSON.parse(editor.projectData))
  const panelIds = project.timeline.map((clip) => clip.metadata.panelId)
  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      id: { in: panelIds },
      storyboard: {
        episode: {
          novelPromotionProject: {
            projectId: input.projectId,
            project: { userId: input.userId },
          },
        },
      },
    },
    include: {
      videoMedia: true,
      lipSyncVideoMedia: true,
    },
  })
  const panelById = new Map(panels.map((panel) => [panel.id, panel]))

  const voiceLineIds = project.timeline.flatMap((clip) => (
    clip.attachment?.audio?.voiceLineId ? [clip.attachment.audio.voiceLineId] : []
  ))
  const voiceLines = voiceLineIds.length > 0
    ? await prisma.novelPromotionVoiceLine.findMany({
      where: {
        id: { in: voiceLineIds },
        episodeId: editor.episodeId,
        episode: {
          novelPromotionProject: {
            projectId: input.projectId,
            project: { userId: input.userId },
          },
        },
      },
      include: { audioMedia: true },
    })
    : []
  const voiceLineById = new Map(voiceLines.map((voiceLine) => [voiceLine.id, voiceLine]))

  const clips: RenderableClip[] = []
  for (const clip of project.timeline) {
    const panel = panelById.get(clip.metadata.panelId)
    if (!panel) throw new Error('EDITOR_RENDER_PANEL_NOT_FOUND')
    const videoStorageKey = panel.lipSyncVideoMedia?.storageKey
      || await resolveStorageKeyFromMediaValue(panel.lipSyncVideoUrl)
      || panel.videoMedia?.storageKey
      || await resolveStorageKeyFromMediaValue(panel.videoUrl)
    if (!videoStorageKey) throw new Error('EDITOR_RENDER_VIDEO_NOT_FOUND')

    const voiceLineId = clip.attachment?.audio?.voiceLineId
    const voiceLine = voiceLineId ? voiceLineById.get(voiceLineId) : null
    const attachmentAudioStorageKey = voiceLine?.audioMedia?.storageKey
      || await resolveStorageKeyFromMediaValue(voiceLine?.audioUrl)

    clips.push({
      clip,
      videoStorageKey,
      attachmentAudioStorageKey,
    })
  }

  const originalAudioStorageKey = project.bgmTrack.some((track) => track.id === 'source-original-audio')
    ? editor.episode.audioMedia?.storageKey
      || await resolveStorageKeyFromMediaValue(editor.episode.audioUrl)
    : null

  return { project, clips, originalAudioStorageKey }
}

function seconds(value: number): string {
  return Math.max(0, value).toFixed(6)
}

async function normalizeClip(input: {
  renderable: RenderableClip
  sourcePath: string
  audioPath: string | null
  outputPath: string
  project: VideoEditorProject
  runner: CommandRunner
}) {
  const { renderable, sourcePath, audioPath, outputPath, project, runner } = input
  const { fps, width, height } = project.config
  const duration = renderable.clip.durationInFrames / fps
  const trimStart = Math.max(0, (renderable.clip.trim?.from || 0) / fps)
  const { stdout: audioProbe } = await runner('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    sourcePath,
  ])
  const sourceHasAudio = audioProbe.trim().length > 0

  const args = [
    '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', seconds(trimStart),
    '-i', sourcePath,
  ]
  let attachmentInputIndex: number | null = null
  if (audioPath) {
    attachmentInputIndex = 1
    args.push('-ss', seconds(trimStart), '-i', audioPath)
  }
  const silenceInputIndex = attachmentInputIndex === null ? 1 : 2
  args.push(
    '-f', 'lavfi',
    '-t', seconds(duration),
    '-i', 'anullsrc=r=48000:cl=stereo',
  )

  const filters = [
    `[0:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,`
      + `fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,`
      + `tpad=stop_mode=clone:stop_duration=${seconds(duration)},`
      + `trim=duration=${seconds(duration)},setpts=PTS-STARTPTS[v]`,
  ]
  const audioSources: string[] = []
  if (!renderable.clip.muted && sourceHasAudio) {
    filters.push(
      `[0:a:0]aresample=48000,aformat=channel_layouts=stereo,`
        + `apad=pad_dur=${seconds(duration)},atrim=duration=${seconds(duration)},`
        + 'asetpts=PTS-STARTPTS[source_audio]',
    )
    audioSources.push('[source_audio]')
  }
  if (attachmentInputIndex !== null) {
    filters.push(
      `[${attachmentInputIndex}:a:0]aresample=48000,aformat=channel_layouts=stereo,`
        + `apad=pad_dur=${seconds(duration)},atrim=duration=${seconds(duration)},`
        + 'asetpts=PTS-STARTPTS[attached_audio]',
    )
    audioSources.push('[attached_audio]')
  }
  if (audioSources.length === 0) {
    filters.push(
      `[${silenceInputIndex}:a:0]atrim=duration=${seconds(duration)},asetpts=PTS-STARTPTS[a]`,
    )
  } else if (audioSources.length === 1) {
    filters.push(`${audioSources[0]}anull[a]`)
  } else {
    filters.push(
      `${audioSources.join('')}amix=inputs=${audioSources.length}:duration=longest:normalize=0,`
        + `atrim=duration=${seconds(duration)}[a]`,
    )
  }

  await runner('ffmpeg', [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-map', '[a]',
    '-t', seconds(duration),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ])
}

function ffmpegTransition(type: string | undefined) {
  if (type === 'slide') return 'slideleft'
  if (type === 'dissolve') return 'dissolve'
  return 'fade'
}

async function joinNormalizedClips(input: {
  project: VideoEditorProject
  segmentPaths: string[]
  tempDir: string
  outputPath: string
  runner: CommandRunner
}) {
  const { project, segmentPaths, tempDir, outputPath, runner } = input
  const hasTransitions = project.timeline.slice(0, -1).some((clip) => (
    clip.transition
    && clip.transition.type !== 'none'
    && clip.transition.durationInFrames > 0
  ))

  if (!hasTransitions) {
    const concatPath = path.join(tempDir, 'concat.txt')
    await fs.writeFile(
      concatPath,
      segmentPaths.map((segmentPath) => `file '${segmentPath.replaceAll("'", "'\\''")}'`).join('\n'),
      'utf8',
    )
    await runner('ffmpeg', [
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ])
    return
  }

  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error']
  for (const segmentPath of segmentPaths) args.push('-i', segmentPath)

  let videoLabel = '[0:v:0]'
  let audioLabel = '[0:a:0]'
  let accumulatedDuration = project.timeline[0].durationInFrames / project.config.fps
  const filters: string[] = []

  for (let index = 1; index < segmentPaths.length; index += 1) {
    const previous = project.timeline[index - 1]
    const currentDuration = project.timeline[index].durationInFrames / project.config.fps
    const requestedTransition = previous.transition
    const transitionDuration = requestedTransition && requestedTransition.type !== 'none'
      ? Math.min(
        requestedTransition.durationInFrames / project.config.fps,
        accumulatedDuration / 3,
        currentDuration / 3,
      )
      : 0
    const nextVideo = `[v${index}]`
    const nextAudio = `[a${index}]`
    if (transitionDuration > 0) {
      filters.push(
        `${videoLabel}[${index}:v:0]xfade=transition=${ffmpegTransition(requestedTransition?.type)}:`
          + `duration=${seconds(transitionDuration)}:offset=${seconds(accumulatedDuration - transitionDuration)}${nextVideo}`,
      )
      filters.push(
        `${audioLabel}[${index}:a:0]acrossfade=d=${seconds(transitionDuration)}${nextAudio}`,
      )
      accumulatedDuration += currentDuration - transitionDuration
    } else {
      filters.push(
        `${videoLabel}${audioLabel}[${index}:v:0][${index}:a:0]`
          + `concat=n=2:v=1:a=1${nextVideo}${nextAudio}`,
      )
      accumulatedDuration += currentDuration
    }
    videoLabel = nextVideo
    audioLabel = nextAudio
  }

  await runner('ffmpeg', [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', videoLabel,
    '-map', audioLabel,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ])
}

async function mixOriginalAudio(input: {
  videoPath: string
  audioPath: string
  outputPath: string
  runner: CommandRunner
}) {
  await input.runner('ffmpeg', [
    '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', input.videoPath,
    '-i', input.audioPath,
    '-filter_complex',
    '[0:a:0][1:a:0]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    input.outputPath,
  ])
}

export async function renderVideoEditorProject(input: {
  editorProjectId: string
  projectId: string
  userId: string
  job?: Job<TaskJobData>
}): Promise<{ storageKey: string; fileName: string }> {
  const source = await resolveRenderSource(input)
  const runner = createCommandRunner({
    timeoutMs: RENDER_TIMEOUT_MS,
    captureLimitBytes: 4 * 1024 * 1024,
  })
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `waoowaoo-editor-${randomUUID()}-`))

  try {
    const segmentPaths: string[] = []
    for (let index = 0; index < source.clips.length; index += 1) {
      const renderable = source.clips[index]
      const sourcePath = path.join(tempDir, `source-${index}.mp4`)
      const audioPath = renderable.attachmentAudioStorageKey
        ? path.join(tempDir, `voice-${index}.audio`)
        : null
      const segmentPath = path.join(tempDir, `segment-${index}.mp4`)
      await materializeStorageObject(renderable.videoStorageKey, sourcePath)
      if (audioPath && renderable.attachmentAudioStorageKey) {
        await materializeStorageObject(renderable.attachmentAudioStorageKey, audioPath)
      }
      await normalizeClip({
        renderable,
        sourcePath,
        audioPath,
        outputPath: segmentPath,
        project: source.project,
        runner,
      })
      segmentPaths.push(segmentPath)
      if (input.job) {
        await reportTaskProgress(input.job, 10 + Math.round(((index + 1) / source.clips.length) * 65), {
          stage: 'editor_render_normalize',
          stageLabel: `正在处理分镜 ${index + 1}/${source.clips.length}`,
        })
      }
    }

    const joinedPath = path.join(tempDir, 'joined.mp4')
    await joinNormalizedClips({
      project: source.project,
      segmentPaths,
      tempDir,
      outputPath: joinedPath,
      runner,
    })
    if (input.job) {
      await reportTaskProgress(input.job, 85, {
        stage: 'editor_render_join',
        stageLabel: '正在合并全部分镜',
      })
    }

    let finalPath = joinedPath
    if (source.originalAudioStorageKey) {
      const originalAudioPath = path.join(tempDir, 'original-audio')
      const mixedPath = path.join(tempDir, 'final.mp4')
      await materializeStorageObject(source.originalAudioStorageKey, originalAudioPath)
      await mixOriginalAudio({
        videoPath: joinedPath,
        audioPath: originalAudioPath,
        outputPath: mixedPath,
        runner,
      })
      finalPath = mixedPath
    }

    const fileName = `waoowaoo-${source.project.episodeId}.mp4`
    const storageKey = generateUniqueKey(
      `editor-exports/${input.projectId}/${source.project.episodeId}`,
      'mp4',
    )
    await uploadObject(await fs.readFile(finalPath), storageKey, undefined, 'video/mp4')
    return { storageKey, fileName }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
