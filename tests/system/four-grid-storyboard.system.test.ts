import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeGridPixelRects } from '@/lib/novel-promotion/grid-storyboard/crop-geometry'
import { persistGridStoryboardOutputs } from '@/lib/novel-promotion/grid-storyboard/persistence'
import { validateGridEpisodePlan } from '@/lib/novel-promotion/grid-storyboard/scene-planner'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { validateAndNormalizeGridUpload } from '@/lib/novel-promotion/six-grid/upload-validation'
import {
  buildFrameLinkResolutionIndex,
  type FrameLinkStoryboard,
} from '@/lib/novel-promotion/video/frame-link-resolver'
import { callRoute } from '../integration/api/helpers/call-route'
import { installAuthMocks, mockAuthenticated, resetAuthMockState } from '../helpers/auth'
import { resetSystemState } from '../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../helpers/fixtures'
import { prisma } from '../helpers/prisma'
import { waitForTaskTerminalState } from './helpers/tasks'
import { startSystemWorkers, stopSystemWorkers, type SystemWorkers } from './helpers/workers'

const fourGridRuntime = vi.hoisted(() => ({
  generationCalls: 0,
  sequence: 0,
  bytes: new Map<string, Buffer>(),
}))

vi.mock('@/lib/config-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/config-service')>('@/lib/config-service')
  return {
    ...actual,
    resolveProjectImageTaskGenerationOptions: vi.fn(async (input: { taskSelections?: Record<string, unknown> }) => ({
      aspectRatio: input.taskSelections?.aspectRatio,
    })),
  }
})

vi.mock('@/lib/workers/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/workers/utils')>('@/lib/workers/utils')
  return {
    ...actual,
    resolveImageSourceFromGeneration: vi.fn(async () => {
      fourGridRuntime.generationCalls += 1
      return 'generated-four-grid-sheet'
    }),
    uploadImageSourceToCos: vi.fn(async (_source: string, _kind: string, targetId: string) => {
      const key = `four-grid-system/${targetId}/${++fourGridRuntime.sequence}.png`
      fourGridRuntime.bytes.set(key, Buffer.from('four-grid-sheet'))
      return key
    }),
  }
})

vi.mock('@/lib/storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/storage')>('@/lib/storage')
  return {
    ...actual,
    getObjectBuffer: vi.fn(async (key: string) => Buffer.from(
      fourGridRuntime.bytes.get(key) ?? 'four-grid-object',
    )),
  }
})

vi.mock('@/lib/media/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/service')>('@/lib/media/service')
  return {
    ...actual,
    ensureMediaObjectFromStorageKey: vi.fn(async (storageKey: string) => {
      const publicId = `four-grid-sheet-${++fourGridRuntime.sequence}`
      const media = await prisma.mediaObject.create({
        data: {
          publicId,
          storageKey,
          sha256: `sha-${publicId}`,
          mimeType: 'image/png',
          sizeBytes: BigInt(fourGridRuntime.bytes.get(storageKey)?.byteLength ?? 1),
        },
      })
      return { ...media, url: `/m/${publicId}` }
    }),
  }
})

vi.mock('@/lib/media/outbound-image', async () => {
  const actual = await vi.importActual<typeof import('@/lib/media/outbound-image')>('@/lib/media/outbound-image')
  return {
    ...actual,
    normalizeReferenceImagesForGeneration: vi.fn(async (references: string[]) => references),
  }
})

vi.mock('@/lib/ai-runtime/client', () => ({
  executeAiVisionStep: vi.fn(async () => ({
    text: JSON.stringify({
      panels: Array.from({ length: 4 }, (_, index) => ({
        panel_number: index + 1,
        description: `grounded panel ${index + 1}`,
        image_prompt: `image prompt ${index + 1}`,
        video_prompt: `video prompt ${index + 1}`,
        duration: 2 + index,
        shot_type: '中景',
        camera_move: '固定',
      })),
    }),
    reasoning: '',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    completion: {},
  })),
}))

vi.mock('@/lib/novel-promotion/six-grid/crop-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/novel-promotion/six-grid/crop-service')>(
    '@/lib/novel-promotion/six-grid/crop-service',
  )
  return {
    ...actual,
    cropSixGridSheet: vi.fn(async (input: {
      sourceMediaId: string
      sourceVersion?: string
      gridSpec?: ReturnType<typeof resolveStoryboardGridSpec>
    }) => {
      const spec = input.gridSpec ?? resolveStoryboardGridSpec('six_grid', '16:9')
      return await Promise.all(Array.from({ length: spec.panelCount }, async (_, cellIndex) => {
        const publicId = `four-grid-crop-${++fourGridRuntime.sequence}`
        const storageKey = `four-grid-system/crops/${publicId}.png`
        const media = await prisma.mediaObject.create({
          data: {
            publicId,
            storageKey,
            sha256: `sha-${publicId}`,
            mimeType: 'image/png',
            sizeBytes: BigInt(1),
          },
        })
        const column = cellIndex % spec.columns
        const row = Math.floor(cellIndex / spec.columns)
        const normalizedCropRect = {
          x: column / spec.columns,
          y: row / spec.rows,
          width: 1 / spec.columns,
          height: 1 / spec.rows,
        }
        return {
          cellIndex,
          mediaId: media.id,
          storageKey,
          url: `/m/${publicId}`,
          pixelRect: { x: column * 800, y: row * 450, width: 800, height: 450 },
          normalizedCropRect,
          lineage: {
            sourceMediaId: input.sourceMediaId,
            sourceStorageKey: 'four-grid-system/source.png',
            sourceDimensions: { width: 1600, height: 900 },
            sourceChecksum: 'source-sha',
            sourceVersion: input.sourceVersion ?? 'v1',
            cropRect: { x: column * 800, y: row * 450, width: 800, height: 450 },
            processingStage: 'six_grid_crop' as const,
            artifactVersion: 1,
            outputChecksum: `sha-${publicId}`,
            outputDimensions: { width: 800, height: 450 },
          },
        }
      }))
    }),
  }
})

const FOUR_GRID_SPEC = resolveStoryboardGridSpec('four_grid', '16:9')

describe('system - four-grid storyboard acceptance', () => {
  it('REQ-NP-FOUR-GRID-01 keeps four-grid as the new-project default without rewriting existing rows', () => {
    for (const filename of ['prisma/schema.prisma', 'prisma/schema.sqlit.prisma']) {
      const schema = fs.readFileSync(path.resolve(process.cwd(), filename), 'utf8')
      expect(schema).toMatch(/storyboardGenerationMode\s+String\s+@default\("four_grid"\)/)
    }
    const migration = fs.readFileSync(path.resolve(
      process.cwd(),
      'prisma/migrations/20260718010000_default_four_grid_storyboards/migration.sql',
    ), 'utf8')
    expect(migration).toContain("DEFAULT 'four_grid'")
    expect(migration).not.toMatch(/\bUPDATE\b/i)
  })

  it('REQ-NP-FOUR-GRID-02 plans exactly four row-major numbered panels', () => {
    const [planned] = validateGridEpisodePlan([sceneGroup('clip-1')], ['clip-1'], FOUR_GRID_SPEC)

    expect(planned.groupId).toBe('four-grid:1:clip-1:1')
    expect(planned.panels.map((panel) => panel.panel_number)).toEqual([1, 2, 3, 4])
  })

  it('REQ-NP-FOUR-GRID-04 accepts an external common-ratio sheet before provider generation', async () => {
    fourGridRuntime.generationCalls = 0
    const source = await sharp({
      create: { width: 160, height: 90, channels: 3, background: '#334455' },
    }).png().toBuffer()

    const normalized = await validateAndNormalizeGridUpload(source, FOUR_GRID_SPEC)

    expect(normalized).toMatchObject({ width: 160, height: 90, mimeType: 'image/webp' })
    expect(fourGridRuntime.generationCalls).toBe(0)
  })

  it('REQ-NP-FOUR-GRID-05 crops a 2x2 sheet into four complete row-major cells', () => {
    const rects = computeGridPixelRects({ width: 1601, height: 901 }, FOUR_GRID_SPEC)
    expect(rects).toEqual([
      { cellIndex: 0, x: 0, y: 0, width: 801, height: 451 },
      { cellIndex: 1, x: 801, y: 0, width: 800, height: 451 },
      { cellIndex: 2, x: 0, y: 451, width: 801, height: 450 },
      { cellIndex: 3, x: 801, y: 451, width: 800, height: 450 },
    ])
  })

  it('REQ-NP-FOUR-GRID-06 orders downstream frames by group sequence then grid cell', () => {
    const visited: string[] = []
    buildFrameLinkResolutionIndex({
      storyboards: [fourGridFrameGroup('group-2', 2, [3, 0, 2, 1]), fourGridFrameGroup('group-1', 1, [2, 1, 3, 0])],
      onPanelVisit: (panel) => visited.push(panel.id),
    })
    expect(visited).toEqual([
      'group-1-0', 'group-1-1', 'group-1-2', 'group-1-3',
      'group-2-0', 'group-2-1', 'group-2-2', 'group-2-3',
    ])
  })

  it('REQ-NP-FOUR-GRID-07 preserves the established six-grid spec and ordering', () => {
    const spec = resolveStoryboardGridSpec('six_grid', '16:9')
    const visited: string[] = []
    buildFrameLinkResolutionIndex({
      storyboards: [{
        id: 'six-1', layoutMode: 'six_grid', groupSequence: 1,
        continuityAnchor: JSON.stringify({ sceneKey: 'office' }),
        panels: [5, 2, 0, 4, 1, 3].map((gridCellIndex) => ({
          id: `six-1-${gridCellIndex}`, storyboardId: 'six-1', panelIndex: 5 - gridCellIndex, gridCellIndex,
        })),
      }],
      onPanelVisit: (panel) => visited.push(panel.id),
    })
    expect(spec).toMatchObject({ columns: 3, rows: 2, panelCount: 6, sheetAspectRatio: '8:3' })
    expect(visited).toEqual(['six-1-0', 'six-1-1', 'six-1-2', 'six-1-3', 'six-1-4', 'six-1-5'])
  })
})

describe('system - four-grid persisted generation chain', () => {
  let workers: SystemWorkers = {}

  beforeEach(async () => {
    fourGridRuntime.generationCalls = 0
    fourGridRuntime.sequence = 0
    fourGridRuntime.bytes.clear()
    await resetSystemState()
    installAuthMocks()
  })

  afterEach(async () => {
    await stopSystemWorkers(workers)
    workers = {}
    resetAuthMockState()
  })

  it('atomically replaces persisted individual and six-grid rows with one valid four-panel group', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id)
    const clips = await Promise.all(['legacy', 'planned'].map((summary) => prisma.novelPromotionClip.create({
      data: { episodeId: episode.id, summary, content: `${summary} content` },
    })))
    const legacyIndividual = await prisma.novelPromotionStoryboard.create({
      data: {
        episodeId: episode.id,
        clipId: clips[0]!.id,
        layoutMode: 'individual',
        panelCount: 1,
        panels: { create: { panelIndex: 0, panelNumber: 1, description: 'legacy individual' } },
      },
      include: { panels: true },
    })
    const legacySix = await prisma.novelPromotionStoryboard.create({
      data: {
        episodeId: episode.id,
        clipId: clips[1]!.id,
        layoutMode: 'six_grid',
        groupSequence: 0,
        panelCount: 6,
        panels: {
          create: Array.from({ length: 6 }, (_, panelIndex) => ({
            panelIndex,
            panelNumber: panelIndex + 1,
            gridCellIndex: panelIndex,
            description: `legacy six ${panelIndex}`,
          })),
        },
      },
      include: { panels: true },
    })
    const run = await prisma.graphRun.create({
      data: {
        userId: user.id,
        projectId: project.id,
        episodeId: episode.id,
        workflowType: 'script_to_storyboard_run',
        taskType: 'script_to_storyboard_run',
        targetType: 'NovelPromotionEpisode',
        targetId: episode.id,
        input: { storyboardGenerationMode: 'four_grid', sixGridCellAspectRatio: '16:9' },
      },
    })
    const [planned] = validateGridEpisodePlan([sceneGroup(clips[1]!.id)], [clips[1]!.id], FOUR_GRID_SPEC)

    await persistGridStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [{ ...planned, clipIndex: 1, finalPanels: planned.panels }],
      voiceLineRows: null,
      runSnapshot: {
        runId: run.id,
        projectId: project.id,
        episodeId: episode.id,
        workflowType: 'script_to_storyboard_run',
        locale: 'en',
        sourceHash: 'four-grid-transition-source',
        runSettings: {
          storyboardGenerationMode: 'four_grid',
          sixGridCellAspectRatio: '16:9',
          gridSpec: FOUR_GRID_SPEC,
          sixGridProcessingOrder: 'crop_then_panel_upscale',
          storyboardUpscaleModel: null,
          dialogueVideoModel: null,
        },
      },
    })

    const storyboards = await prisma.novelPromotionStoryboard.findMany({
      where: { episodeId: episode.id },
      include: { panels: { orderBy: { panelIndex: 'asc' } } },
    })
    const legacyPanelIds = [...legacyIndividual.panels, ...legacySix.panels].map((panel) => panel.id)
    expect(storyboards).toHaveLength(1)
    expect(storyboards[0]).toMatchObject({ layoutMode: 'four_grid', groupSequence: 1, panelCount: 4 })
    expect(storyboards[0]!.panels.map((panel) => [panel.panelIndex, panel.gridCellIndex]))
      .toEqual([[0, 0], [1, 1], [2, 2], [3, 3]])
    expect(await prisma.novelPromotionPanel.count({ where: { id: { in: legacyPanelIds } } })).toBe(0)
    expect(await prisma.novelPromotionPanel.count({
      where: { storyboard: { episodeId: episode.id } },
    })).toBe(4)
  })

  it('deletes one shared-clip grid group without deleting its sibling and clears voice matches', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id)
    const clip = await prisma.novelPromotionClip.create({
      data: { episodeId: episode.id, summary: 'shared scene', content: 'Two storyboard groups share this clip.' },
    })
    const selected = await prisma.novelPromotionStoryboard.create({
      data: {
        episodeId: episode.id,
        clipId: clip.id,
        layoutMode: 'four_grid',
        groupSequence: 0,
        panelCount: 4,
        panels: {
          create: Array.from({ length: 4 }, (_, panelIndex) => ({
            panelIndex,
            panelNumber: panelIndex + 1,
            gridCellIndex: panelIndex,
            description: `selected ${panelIndex}`,
          })),
        },
      },
      include: { panels: true },
    })
    const sibling = await prisma.novelPromotionStoryboard.create({
      data: {
        episodeId: episode.id,
        clipId: clip.id,
        layoutMode: 'four_grid',
        groupSequence: 1,
        panelCount: 4,
        panels: {
          create: Array.from({ length: 4 }, (_, panelIndex) => ({
            panelIndex,
            panelNumber: panelIndex + 1,
            gridCellIndex: panelIndex,
            description: `sibling ${panelIndex}`,
          })),
        },
      },
      include: { panels: true },
    })
    const voiceLine = await prisma.novelPromotionVoiceLine.create({
      data: {
        episodeId: episode.id,
        lineIndex: 0,
        speaker: 'Narrator',
        content: 'Matched to the selected group.',
        matchedStoryboardId: selected.id,
        matchedPanelId: selected.panels[0]!.id,
        matchedPanelIndex: 0,
      },
    })
    mockAuthenticated(user.id)

    const route = await import('@/app/api/novel-promotion/[projectId]/storyboard-group/route')
    const response = await callRoute(route.DELETE, 'DELETE', undefined, {
      params: { projectId: project.id },
      query: { storyboardId: selected.id },
    })

    expect(response.status).toBe(200)
    expect(await prisma.novelPromotionStoryboard.findUnique({ where: { id: selected.id } })).toBeNull()
    expect(await prisma.novelPromotionStoryboard.findUnique({ where: { id: sibling.id } })).toMatchObject({
      id: sibling.id,
      clipId: clip.id,
    })
    expect(await prisma.novelPromotionClip.findUnique({ where: { id: clip.id } })).toMatchObject({ id: clip.id })
    expect(await prisma.novelPromotionPanel.count({ where: { storyboardId: sibling.id } })).toBe(4)
    expect(await prisma.novelPromotionVoiceLine.findUnique({ where: { id: voiceLine.id } })).toMatchObject({
      matchedStoryboardId: null,
      matchedPanelId: null,
      matchedPanelIndex: null,
    })
  })

  it('REQ-NP-FOUR-GRID-03 persists planning lineage, generates one common-ratio sheet, and owns four crop media', async () => {
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id)
    const clip = await prisma.novelPromotionClip.create({
      data: { episodeId: episode.id, summary: 'office', content: 'Ming crosses the office.' },
    })
    const run = await prisma.graphRun.create({
      data: {
        userId: user.id,
        projectId: project.id,
        episodeId: episode.id,
        workflowType: 'script_to_storyboard_run',
        taskType: 'script_to_storyboard_run',
        targetType: 'NovelPromotionEpisode',
        targetId: episode.id,
        input: { storyboardGenerationMode: 'four_grid', sixGridCellAspectRatio: '16:9' },
      },
    })
    const [planned] = validateGridEpisodePlan([sceneGroup(clip.id)], [clip.id], FOUR_GRID_SPEC)
    const runSnapshot = Object.freeze({
      runId: run.id,
      projectId: project.id,
      episodeId: episode.id,
      workflowType: 'script_to_storyboard_run',
      locale: 'en' as const,
      sourceHash: 'four-grid-system-source',
      runSettings: Object.freeze({
        storyboardGenerationMode: 'four_grid' as const,
        sixGridCellAspectRatio: '16:9' as const,
        gridSpec: FOUR_GRID_SPEC,
        sixGridProcessingOrder: 'crop_then_panel_upscale' as const,
        storyboardUpscaleModel: null,
        dialogueVideoModel: null,
      }),
    })
    const persisted = await persistGridStoryboardOutputs({
      episodeId: episode.id,
      runId: run.id,
      clipPanels: [{ ...planned, clipIndex: 1, finalPanels: planned.panels }],
      voiceLineRows: null,
      runSnapshot,
    })
    const storyboardId = persisted.persistedStoryboards[0]!.storyboardId
    mockAuthenticated(user.id)
    workers = await startSystemWorkers(['image'])

    const sheetRoute = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/route')
    const generatedResponse = await callRoute(sheetRoute.POST, 'POST', {
      operation: 'generate',
      episodeId: episode.id,
      storyboardId,
      imageModel: 'fal::banana/storyboard',
      locale: 'en',
    }, { params: { projectId: project.id } })
    expect(generatedResponse.status).toBe(200)
    const generated = await generatedResponse.json() as { taskId: string }
    expect((await waitForTaskTerminalState(generated.taskId)).status).toBe('completed')

    const cropRoute = await import('@/app/api/novel-promotion/[projectId]/storyboard-sheet/crop/route')
    const cropResponse = await callRoute(cropRoute.POST, 'POST', {
      episodeId: episode.id,
      storyboardId,
      locale: 'en',
    }, { params: { projectId: project.id } })
    expect(cropResponse.status).toBe(200)
    const cropped = await cropResponse.json() as { taskId: string }
    expect((await waitForTaskTerminalState(cropped.taskId)).status).toBe('completed')

    const result = await prisma.novelPromotionStoryboard.findUniqueOrThrow({
      where: { id: storyboardId },
      include: { panels: { orderBy: { gridCellIndex: 'asc' } } },
    })
    const artifact = await prisma.graphArtifact.findFirstOrThrow({ where: { runId: run.id } })
    expect(fourGridRuntime.generationCalls).toBe(1)
    expect(result).toMatchObject({
      layoutMode: 'four_grid',
      panelCount: 4,
      sixGridCellAspectRatio: '16:9',
      sheetPromptSnapshot: expect.stringContaining('exactly 2 columns x 2 rows'),
      sheetImageMediaId: expect.any(String),
    })
    expect(result.sheetGenerationOptionsSnapshot).toContain('"aspectRatio":"16:9"')
    expect(result.sheetGenerationOptionsSnapshot).toContain('"lineage":')
    expect(artifact.payload).toMatchObject({
      runSettings: {
        storyboardGenerationMode: 'four_grid',
        gridSpec: { mode: 'four_grid', columns: 2, rows: 2, panelCount: 4, sheetAspectRatio: '16:9' },
      },
    })
    expect(result.panels.map((panel) => panel.gridCellIndex)).toEqual([0, 1, 2, 3])
    expect(result.panels.every((panel) => panel.imageMediaId === panel.croppedImageMediaId)).toBe(true)
    const panelMediaIds = result.panels.map((panel) => panel.imageMediaId).filter((id): id is string => !!id)
    expect(panelMediaIds).toHaveLength(4)
    expect(await prisma.mediaObject.count({ where: { id: { in: panelMediaIds } } })).toBe(4)
  })

})

function sceneGroup(clipId: string) {
  return {
    sceneKey: 'office',
    clipId,
    incomingContinuity: 'Ming enters the office in a blue coat.',
    outgoingContinuity: 'Ming remains in the office in the blue coat.',
    panels: Array.from({ length: 4 }, (_, index) => ({
      panel_number: index + 1,
      description: `office visual beat ${index + 1}`,
      location: 'office',
      source_text: `source beat ${index + 1}`,
      characters: [{ name: 'Ming' }],
      props: ['folder'],
      duration: 2.5 + index,
    })),
  }
}

function fourGridFrameGroup(
  id: string,
  groupSequence: number,
  cellIndexes: number[],
): FrameLinkStoryboard {
  return {
    id,
    layoutMode: 'four_grid',
    groupSequence,
    continuityAnchor: JSON.stringify({ sceneKey: 'office' }),
    panels: cellIndexes.map((gridCellIndex, panelIndex) => ({
      id: `${id}-${gridCellIndex}`,
      storyboardId: id,
      panelIndex,
      gridCellIndex,
    })),
  }
}
