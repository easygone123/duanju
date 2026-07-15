import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import type { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { preprocessViralVideo } from '@/lib/viral-replication/preprocess'
import { getViralReplicationRuntimeHealth } from '@/lib/viral-replication/runtime-health'
import { createViralReplicationAnalysisHandler } from '@/lib/workers/handlers/viral-replication-analysis'
import { createViralReplicationGenerationHandler } from '@/lib/workers/handlers/viral-replication-generation'
import type { TaskJobData } from '@/lib/task/types'
import { callRoute } from '../integration/api/helpers/call-route'
import { installAuthMocks, mockAuthenticated, resetAuthMockState } from '../helpers/auth'
import { resetSystemState } from '../helpers/db-reset'
import { prisma } from '../helpers/prisma'

const systemState = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  submittedTasks: [] as Array<Record<string, unknown>>,
  nextTask: 1,
}))

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>()
  return {
    ...actual,
    uploadObjectStream: vi.fn(async (streamFactory: () => NodeJS.ReadableStream, key: string) => {
      const chunks: Buffer[] = []
      for await (const chunk of streamFactory() as AsyncIterable<Buffer | Uint8Array | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      systemState.objects.set(key, Buffer.concat(chunks))
      return key
    }),
    deleteObject: vi.fn(async (key: string) => { systemState.objects.delete(key) }),
  }
})

vi.mock('@/lib/task/submitter', () => ({
  submitTask: vi.fn(async (input: Record<string, unknown>) => {
    const taskId = `viral-system-task-${systemState.nextTask++}`
    systemState.submittedTasks.push({ ...input, taskId })
    return { taskId }
  }),
}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await fs.rm(directory, { recursive: true, force: true })
  }))
  resetAuthMockState()
})

describe('system - viral replication runtime acceptance', () => {
  beforeEach(() => {
    systemState.objects.clear()
    systemState.submittedTasks.length = 0
    systemState.nextTask = 1
    vi.clearAllMocks()
  })

  it('runs the committed three-scene fixture through the real FFmpeg and FFprobe boundary', async () => {
    const health = await getViralReplicationRuntimeHealth()
    expect(health).toEqual({ available: true, ffmpeg: true, ffprobe: true })

    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-system-'))
    temporaryDirectories.push(outputDirectory)
    const result = await preprocessViralVideo({
      sourcePath: path.resolve('tests/fixtures/viral-replication/three-scenes.mp4'),
      outputDirectory,
    })
    expect(result.metadata).toMatchObject({
      durationMs: 15_000,
      width: 320,
      height: 180,
      hasVideo: true,
    })
    expect(result.shots.length).toBeGreaterThanOrEqual(3)
    for (const shot of result.shots) {
      expect((await fs.stat(shot.framePath)).size).toBeGreaterThan(0)
    }
  })

  it.runIf(process.env.SYSTEM_TEST_BOOTSTRAP === '1')(
    'accepts upload, deterministic analysis, brief confirmation, editable generation, and stable refetch',
    async () => {
      await resetSystemState()
      installAuthMocks()
      const user = await prisma.user.create({
        data: { name: 'viral-system-user', email: 'viral-system@example.com' },
      })
      mockAuthenticated(user.id)
      await prisma.userPreference.create({
        data: {
          userId: user.id,
          analysisModel: 'system::deterministic-analysis',
          characterModel: 'system::character',
          locationModel: 'system::location',
          storyboardModel: 'system::storyboard',
          editModel: 'system::edit',
          videoModel: 'system::video',
          audioModel: 'system::audio',
          videoRatio: '9:16',
          videoResolution: '720p',
          artStyle: 'realistic',
          ttsRate: '+0%',
          imageResolution: '2K',
        },
      })

      const {
        createViralReplication,
        generateViralReplication,
        getOwnedViralReplicationDetail,
        updateViralReplicationBrief,
        uploadViralReplicationVideo,
      } = await import('@/lib/viral-replication/service')
      const created = await createViralReplication({
        userId: user.id,
        brief: 'Create an original rescue story with the same fast escalation',
        videoRatio: '9:16',
        artStyle: 'realistic',
      })
      expect(created).toMatchObject({ status: 'uploading' })
      expect(await prisma.viralReplication.findUnique({ where: { id: created.id } }))
        .toMatchObject({ projectId: null, episodeId: null, sourceVideoMediaId: null })

      const fixtureBytes = await fs.readFile('tests/fixtures/viral-replication/three-scenes.mp4')
      const uploaded = await uploadViralReplicationVideo({
        id: created.id,
        userId: user.id,
        request: new Request('http://localhost/viral-video', {
          method: 'PUT',
          headers: { 'content-type': 'video/mp4' },
          body: new Uint8Array(fixtureBytes),
        }),
        mimeType: 'video/mp4',
        locale: 'en',
      })
      expect(uploaded).toMatchObject({
        status: 'analyzing',
        projectId: expect.any(String),
        episodeId: expect.any(String),
        sourceVideoMediaId: expect.any(String),
      })
      expect(await prisma.project.count({ where: { userId: user.id } })).toBe(1)
      expect(await prisma.novelPromotionEpisode.count({ where: { id: uploaded.episodeId } })).toBe(1)
      expect(await prisma.mediaObject.count({ where: { id: uploaded.sourceVideoMediaId } })).toBe(1)

      const analysisSubmission = systemState.submittedTasks.at(-1)!
      let analyzedShots: Array<Record<string, unknown>> = []
      let visionOffset = 0
      const makeCompletion = (content: string) => ({
        id: 'deterministic',
        object: 'chat.completion',
        created: 0,
        model: 'system::deterministic-analysis',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content, refusal: null },
        }],
      })
      const analysisHandler = createViralReplicationAnalysisHandler({
        prisma: prisma as never,
        getObjectStream: async (key) => {
          const bytes = systemState.objects.get(key)
          if (!bytes) throw new Error(`missing system object: ${key}`)
          return Readable.from(bytes)
        },
        preprocess: async (options) => {
          const result = await preprocessViralVideo(options)
          analyzedShots = result.shots.map((shot) => ({
            shotIndex: shot.shotIndex,
            startMs: shot.startMs,
            endMs: shot.endMs,
            shotType: 'medium shot',
            cameraAngle: 'eye-level',
            cameraMove: 'static',
            composition: 'centered subject',
            actionBeat: `original action ${shot.shotIndex}`,
            transition: 'cut',
            subtitleSummary: null,
            narrativeFunction: `beat ${shot.shotIndex}`,
          }))
          return result
        },
        readFrame: fs.readFile,
        uploadObject: async (body, key) => {
          systemState.objects.set(key, Buffer.from(body))
          return key
        },
        deleteObject: async (key) => { systemState.objects.delete(key) },
        runVision: async (input) => {
          const batch = analyzedShots.slice(visionOffset, visionOffset + input.imageUrls.length)
          visionOffset += batch.length
          return makeCompletion(JSON.stringify({ shots: batch })) as never
        },
        runText: async () => makeCompletion(JSON.stringify({
          schemaVersion: 1,
          overview: {
            hook: 'Immediate visual change',
            coreAppeal: 'Escalation and release',
            pacing: 'Three clear beats',
            emotionalArc: 'Concern to relief',
          },
          styleFingerprint: {
            composition: ['centered subjects'],
            lighting: ['clean daylight'],
            color: ['distinct scene colors'],
            editing: ['hard scene cuts'],
          },
          shots: analyzedShots,
          originalAdaptationAdvice: ['Replace people, setting, actions, and dialogue.'],
        })) as never,
        reportProgress: async () => undefined,
        touchTaskHeartbeat: async () => true,
        makeTempDirectory: async () => {
          const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-system-analysis-'))
          temporaryDirectories.push(directory)
          return directory
        },
        removeTempDirectory: async (directory) => {
          await fs.rm(directory, { recursive: true, force: true })
          const index = temporaryDirectories.indexOf(directory)
          if (index >= 0) temporaryDirectories.splice(index, 1)
        },
        now: () => new Date(),
        createExecutionToken: () => 'viral-system-execution-token',
        warn: () => undefined,
      })
      await analysisHandler({
        data: {
          ...analysisSubmission,
          taskId: analysisSubmission.taskId,
          locale: 'en',
          payload: analysisSubmission.payload,
        },
      } as unknown as Job<TaskJobData>)

      const reviewed = await getOwnedViralReplicationDetail(created.id, user.id)
      expect(reviewed).toMatchObject({ status: 'review_ready', reportVersion: 1, durationMs: 15_000 })
      expect(await prisma.viralReplicationFrame.count({ where: { replicationId: created.id } }))
        .toBeGreaterThanOrEqual(3)

      const confirmedBrief = 'Original alpine rescue; no copied characters, plot, or dialogue'
      await updateViralReplicationBrief({ id: created.id, userId: user.id, brief: confirmedBrief })
      const generating = await generateViralReplication({
        id: created.id,
        userId: user.id,
        locale: 'en',
        brief: confirmedBrief,
      })
      expect(generating.status).toBe('generating')
      const generationSubmission = systemState.submittedTasks.at(-1)!
      let generationPrompt = ''
      const generationHandler = createViralReplicationGenerationHandler({
        prisma: prisma as never,
        runText: async (input) => {
          generationPrompt = String(input.messages[0]?.content || '')
          return makeCompletion(JSON.stringify({
            schemaVersion: 1,
            title: 'Alpine Rescue',
            synopsis: 'A climber organizes an original three-step rescue.',
            novelText: 'An entirely original alpine rescue story.',
            characters: [{ name: 'Lin', description: 'An original mountain rescuer.' }],
            storyboards: [{
              sequence: 0,
              summary: 'Preparation, danger, and rescue.',
              panels: Array.from({ length: 3 }, (_, panelIndex) => ({
                panelIndex,
                durationSeconds: 2,
                shotType: 'medium shot',
                cameraMove: 'slow push',
                description: `Original rescue panel ${panelIndex + 1}`,
                imagePrompt: `Original alpine image prompt ${panelIndex + 1}`,
                videoPrompt: `Original alpine video prompt ${panelIndex + 1}`,
                sourceNarrativeFunction: `beat ${panelIndex}`,
              })),
            }],
          })) as never
        },
        persist: async (input) => {
          const { persistViralStoryboardGeneration } = await import('@/lib/viral-replication/persistence')
          await persistViralStoryboardGeneration(input)
        },
        reportProgress: async () => undefined,
      })
      await generationHandler({
        data: {
          ...generationSubmission,
          taskId: generationSubmission.taskId,
          locale: 'en',
          payload: generationSubmission.payload,
        },
      } as unknown as Job<TaskJobData>)
      expect(generationPrompt).toContain(confirmedBrief)

      const panels = await prisma.novelPromotionPanel.findMany({
        where: { storyboard: { episodeId: uploaded.episodeId } },
        orderBy: { panelIndex: 'asc' },
      })
      expect(panels).toHaveLength(3)
      expect(panels.every((panel) => Boolean(panel.imagePrompt && panel.videoPrompt))).toBe(true)

      const { GET: getStage } = await import(
        '@/app/api/novel-promotion/[projectId]/episodes/[episodeId]/stage/[stage]/route'
      )
      const stageResponse = await callRoute(getStage, 'GET', undefined, {
        params: {
          projectId: uploaded.projectId!,
          episodeId: uploaded.episodeId!,
          stage: 'storyboard',
        },
      })
      expect(stageResponse.status).toBe(200)
      expect(await stageResponse.json()).toMatchObject({
        episode: {
          storyboards: [{ panels: expect.arrayContaining([
            expect.objectContaining({ imagePrompt: expect.any(String), videoPrompt: expect.any(String) }),
          ]) }],
        },
      })

      expect(systemState.submittedTasks.map((task) => task.type)).toEqual([
        'viral_video_analysis',
        'viral_storyboard_generation',
      ])
      const firstRefetch = await getOwnedViralReplicationDetail(created.id, user.id)
      const secondRefetch = await getOwnedViralReplicationDetail(created.id, user.id)
      expect(firstRefetch).toMatchObject({
        status: 'completed',
        project: { id: uploaded.projectId },
        episode: { id: uploaded.episodeId },
      })
      expect(secondRefetch.reportJson).toEqual(firstRefetch.reportJson)
      expect(secondRefetch.project).toEqual(firstRefetch.project)
      expect(secondRefetch.episode).toEqual(firstRefetch.episode)
    },
    60_000,
  )
})
