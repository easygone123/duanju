import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api-errors'
import {
  assertSixGridUploadAvailable,
  replaceSixGridSheet,
  type SixGridUploadStore,
  type SixGridUploadTransaction,
} from '@/lib/novel-promotion/six-grid/upload-service'
import { TASK_STATUS, TASK_TYPE } from '@/lib/task/types'

type StoryboardFixture = {
  id: string
  episodeId: string
  projectId: string
  userId: string
  layoutMode: string
  sheetArtifactVersion: number
  sheetImageMediaId: string | null
  sheetImageUrl: string | null
  upscaledSheetImageMediaId: string | null
  upscaledSheetImageUrl: string | null
  imageHistory: string | null
  lastError: string | null
  storyboardTextJson: string
  candidateImages: string
  sheetPromptSnapshot: string
  sheetModelSnapshot: string
  sheetGenerationOptionsSnapshot: string
  continuityAnchor: string
  photographyPlan: string
  groupSequence: number
  sixGridCellAspectRatio: string
  sixGridProcessingOrder: string
}

type PanelFixture = {
  id: string
  storyboardId: string
  panelIndex: number
  panelNumber: number
  description: string
  imagePrompt: string
  hasDialogue: boolean
  dialogueSpeaker: string
  dialogueText: string
  dialogueEmotion: string
  duration: number
  estimatedDuration: number
  durationOverride: number
  videoPrompt: string
  firstLastFramePrompt: string
  videoUrl: string
  videoMediaId: string
  videoGenerationMode: string
  photographyRules: string
  actingNotes: string
  linkedToNextPanel: boolean
  firstFrameSourceMeta: string
  lastFrameSourceMeta: string
  imageMediaId: string | null
  imageUrl: string | null
  imageHistory: string | null
  candidateImages: string | null
  previousImageMediaId: string | null
  previousImageUrl: string | null
  normalizedCropRect: string | null
  croppedImageMediaId: string | null
  croppedImageUrl: string | null
  upscaledImageMediaId: string | null
  upscaledImageUrl: string | null
  imageDerivation: string | null
  imageLineage: string | null
}

type TaskFixture = {
  id: string
  userId: string
  projectId: string
  episodeId: string
  targetType: string
  targetId: string
  type: string
  status: string
}

type FixtureState = {
  storyboard: StoryboardFixture
  panels: PanelFixture[]
  tasks: TaskFixture[]
}

const input = {
  userId: 'user-1',
  projectId: 'project-1',
  episodeId: 'episode-1',
  storyboardId: 'storyboard-1',
  expectedSheetArtifactVersion: 4,
  media: { id: 'media-new', url: 'https://cdn.example/new-sheet.png' },
}

const clearedPanelImageFields = {
  imageMediaId: null,
  imageUrl: null,
  imageHistory: null,
  candidateImages: null,
  previousImageMediaId: null,
  previousImageUrl: null,
  normalizedCropRect: null,
  croppedImageMediaId: null,
  croppedImageUrl: null,
  upscaledImageMediaId: null,
  upscaledImageUrl: null,
  imageDerivation: null,
  imageLineage: null,
}

function createState(panelCount = 6): FixtureState {
  return {
    storyboard: {
      id: input.storyboardId,
      episodeId: input.episodeId,
      projectId: input.projectId,
      userId: input.userId,
      layoutMode: 'six_grid',
      sheetArtifactVersion: 4,
      sheetImageMediaId: 'media-old-sheet',
      sheetImageUrl: 'https://cdn.example/old-sheet.png',
      upscaledSheetImageMediaId: 'media-old-upscale',
      upscaledSheetImageUrl: 'https://cdn.example/old-upscale.png',
      imageHistory: '[{"mediaId":"media-old-sheet"}]',
      lastError: 'old generation error',
      storyboardTextJson: '{"shots":[1,2,3,4,5,6]}',
      candidateImages: '["storyboard-candidate"]',
      sheetPromptSnapshot: 'sheet prompt snapshot',
      sheetModelSnapshot: 'sheet model snapshot',
      sheetGenerationOptionsSnapshot: '{"seed":42}',
      continuityAnchor: '{"incoming":"hall","outgoing":"roof"}',
      photographyPlan: '{"lens":"35mm"}',
      groupSequence: 3,
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'crop_then_panel_upscale',
    },
    panels: Array.from({ length: panelCount }, (_, index) => ({
      id: `panel-${index + 1}`,
      storyboardId: input.storyboardId,
      panelIndex: index,
      panelNumber: index + 1,
      description: `description-${index + 1}`,
      imagePrompt: `image-prompt-${index + 1}`,
      hasDialogue: index % 2 === 0,
      dialogueSpeaker: `speaker-${index + 1}`,
      dialogueText: `dialogue-${index + 1}`,
      dialogueEmotion: `emotion-${index + 1}`,
      duration: 2.5 + index,
      estimatedDuration: 2 + index,
      durationOverride: 3 + index,
      videoPrompt: `video-prompt-${index + 1}`,
      firstLastFramePrompt: `frame-prompt-${index + 1}`,
      videoUrl: `https://cdn.example/video-${index + 1}.mp4`,
      videoMediaId: `video-media-${index + 1}`,
      videoGenerationMode: 'firstlastframe',
      photographyRules: `photo-rules-${index + 1}`,
      actingNotes: `acting-notes-${index + 1}`,
      linkedToNextPanel: index < panelCount - 1,
      firstFrameSourceMeta: `first-meta-${index + 1}`,
      lastFrameSourceMeta: `last-meta-${index + 1}`,
      imageMediaId: `image-${index + 1}`,
      imageUrl: `https://cdn.example/image-${index + 1}.png`,
      imageHistory: `["history-${index + 1}"]`,
      candidateImages: `["candidate-${index + 1}"]`,
      previousImageMediaId: `previous-${index + 1}`,
      previousImageUrl: `https://cdn.example/previous-${index + 1}.png`,
      normalizedCropRect: '{"x":0,"y":0,"width":1,"height":1}',
      croppedImageMediaId: `crop-${index + 1}`,
      croppedImageUrl: `https://cdn.example/crop-${index + 1}.png`,
      upscaledImageMediaId: `upscale-${index + 1}`,
      upscaledImageUrl: `https://cdn.example/upscale-${index + 1}.png`,
      imageDerivation: 'panel_upscale',
      imageLineage: `{"source":"crop-${index + 1}"}`,
    })),
    tasks: [],
  }
}

class InMemorySixGridUploadStore implements SixGridUploadStore {
  private state: FixtureState
  private readonly readBackOverride?: {
    sheetImageMediaId: string | null
    sheetImageUrl: string | null
    sheetArtifactVersion: number
  }
  lastAvailabilityQuery: unknown = null
  transactionCount = 0
  storyboardWriteCount = 0
  panelWriteCount = 0
  readonly events: string[] = []
  private readonly onStoryboardLocked?: (state: FixtureState) => void

  constructor(state: FixtureState, readBackOverride?: {
    sheetImageMediaId: string | null
    sheetImageUrl: string | null
    sheetArtifactVersion: number
  }, onStoryboardLocked?: (state: FixtureState) => void) {
    this.state = structuredClone(state)
    this.readBackOverride = readBackOverride
    this.onStoryboardLocked = onStoryboardLocked
  }

  snapshot(): FixtureState {
    return structuredClone(this.state)
  }

  async findActiveTask(args: Parameters<SixGridUploadStore['findActiveTask']>[0]) {
    this.lastAvailabilityQuery = structuredClone(args)
    this.events.push('availability')
    return findActiveTask(this.state, args)
  }

  async transaction<T>(operation: (transaction: SixGridUploadTransaction) => Promise<T>): Promise<T> {
    this.transactionCount += 1
    this.events.push('transaction')
    const draft = structuredClone(this.state)
    const transaction: SixGridUploadTransaction = {
      lockOwnedStoryboard: async (identity) => {
        this.events.push('storyboard-lock')
        this.onStoryboardLocked?.(this.state)
        this.onStoryboardLocked?.(draft)
        const storyboard = draft.storyboard
        return storyboard.id === identity.storyboardId
          && storyboard.episodeId === identity.episodeId
          && storyboard.projectId === identity.projectId
          && storyboard.userId === identity.userId
          && storyboard.layoutMode === (identity.gridSpec?.mode ?? 'six_grid')
      },
      findActiveTask: async (args) => {
        this.lastAvailabilityQuery = structuredClone(args)
        this.events.push('availability')
        return findActiveTask(draft, args)
      },
      replaceOwnedStoryboard: async (replacement) => {
        const storyboard = draft.storyboard
        const matches = storyboard.id === replacement.storyboardId
          && storyboard.episodeId === replacement.episodeId
          && storyboard.projectId === replacement.projectId
          && storyboard.userId === replacement.userId
          && storyboard.layoutMode === (replacement.gridSpec?.mode ?? 'six_grid')
          && storyboard.sheetArtifactVersion === replacement.expectedSheetArtifactVersion
        if (!matches) return { count: 0 }
        this.storyboardWriteCount += 1
        Object.assign(storyboard, {
          sheetImageMediaId: replacement.mediaId,
          sheetImageUrl: replacement.url,
          upscaledSheetImageMediaId: null,
          upscaledSheetImageUrl: null,
          imageHistory: null,
          lastError: null,
          sheetArtifactVersion: storyboard.sheetArtifactVersion + 1,
        })
        return { count: 1 }
      },
      clearStoryboardPanels: async (storyboardId) => {
        const panels = draft.panels.filter((panel) => panel.storyboardId === storyboardId)
        this.panelWriteCount += panels.length
        for (const panel of panels) Object.assign(panel, clearedPanelImageFields)
        return { count: panels.length }
      },
      readStoryboardSheet: async (storyboardId) => {
        if (this.readBackOverride) return this.readBackOverride
        return draft.storyboard.id === storyboardId
          ? {
              sheetImageMediaId: draft.storyboard.sheetImageMediaId,
              sheetImageUrl: draft.storyboard.sheetImageUrl,
              sheetArtifactVersion: draft.storyboard.sheetArtifactVersion,
            }
          : null
      },
    }
    const result = await operation(transaction)
    this.state = draft
    return result
  }
}

function findActiveTask(state: FixtureState, args: Parameters<SixGridUploadStore['findActiveTask']>[0]) {
  const where = args.where
  return state.tasks.find((task) => (
    task.userId === where.userId
    && task.projectId === where.projectId
    && task.episodeId === where.episodeId
    && task.targetType === where.targetType
    && task.targetId === where.targetId
    && where.type.in.includes(task.type)
    && where.status.in.includes(task.status)
  )) ?? null
}

function activeTask(type: string, status: string): TaskFixture {
  return {
    id: `task-${type}-${status}`,
    userId: input.userId,
    projectId: input.projectId,
    episodeId: input.episodeId,
    targetType: 'NovelPromotionStoryboard',
    targetId: input.storyboardId,
    type,
    status,
  }
}

function expectConflict(error: unknown, detailCode: string) {
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({ code: 'CONFLICT', details: { code: detailCode } })
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to reject')
}

describe('atomic six-grid sheet replacement', () => {
  it('replaces version 4 with 5 and clears stale sheet and panel image lineage', async () => {
    const store = new InMemorySixGridUploadStore(createState())

    const result = await replaceSixGridSheet(input, store)
    const state = store.snapshot()

    expect(result).toEqual({
      mediaId: input.media.id,
      url: input.media.url,
      sheetArtifactVersion: 5,
    })
    expect(state.storyboard).toMatchObject({
      sheetImageMediaId: input.media.id,
      sheetImageUrl: input.media.url,
      upscaledSheetImageMediaId: null,
      upscaledSheetImageUrl: null,
      imageHistory: null,
      lastError: null,
      sheetArtifactVersion: 5,
    })
    expect(state.panels).toHaveLength(6)
    for (const panel of state.panels) expect(panel).toMatchObject(clearedPanelImageFields)
    expect(store.events).toEqual([
      'availability',
      'transaction',
      'storyboard-lock',
      'availability',
    ])
  })

  it('atomically replaces a four-grid sheet and clears exactly four derived panels', async () => {
    const state = createState(4)
    state.storyboard.layoutMode = 'four_grid'
    const store = new InMemorySixGridUploadStore(state)

    await expect(replaceSixGridSheet({
      ...input,
      gridSpec: {
        mode: 'four_grid', columns: 2, rows: 2, panelCount: 4,
        cellAspectRatio: '16:9', sheetAspectRatio: '16:9',
      },
    }, store)).resolves.toEqual({
      mediaId: input.media.id,
      url: input.media.url,
      sheetArtifactVersion: 5,
    })
    expect(store.snapshot().panels).toHaveLength(4)
    expect(store.snapshot().panels.every((panel) => panel.imageMediaId === null)).toBe(true)
  })

  it('preserves storyboard planning snapshots and panel content, video, planning, and ordering data', async () => {
    const initial = createState()
    const store = new InMemorySixGridUploadStore(initial)
    const preservedStoryboard = {
      storyboardTextJson: initial.storyboard.storyboardTextJson,
      candidateImages: initial.storyboard.candidateImages,
      sheetPromptSnapshot: initial.storyboard.sheetPromptSnapshot,
      sheetModelSnapshot: initial.storyboard.sheetModelSnapshot,
      sheetGenerationOptionsSnapshot: initial.storyboard.sheetGenerationOptionsSnapshot,
      continuityAnchor: initial.storyboard.continuityAnchor,
      photographyPlan: initial.storyboard.photographyPlan,
      groupSequence: initial.storyboard.groupSequence,
      sixGridCellAspectRatio: initial.storyboard.sixGridCellAspectRatio,
      sixGridProcessingOrder: initial.storyboard.sixGridProcessingOrder,
    }
    const preservedPanels = initial.panels.map((panel) => ({
      id: panel.id,
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
      panelNumber: panel.panelNumber,
      description: panel.description,
      imagePrompt: panel.imagePrompt,
      hasDialogue: panel.hasDialogue,
      dialogueSpeaker: panel.dialogueSpeaker,
      dialogueText: panel.dialogueText,
      dialogueEmotion: panel.dialogueEmotion,
      duration: panel.duration,
      estimatedDuration: panel.estimatedDuration,
      durationOverride: panel.durationOverride,
      videoPrompt: panel.videoPrompt,
      firstLastFramePrompt: panel.firstLastFramePrompt,
      videoUrl: panel.videoUrl,
      videoMediaId: panel.videoMediaId,
      videoGenerationMode: panel.videoGenerationMode,
      photographyRules: panel.photographyRules,
      actingNotes: panel.actingNotes,
      linkedToNextPanel: panel.linkedToNextPanel,
      firstFrameSourceMeta: panel.firstFrameSourceMeta,
      lastFrameSourceMeta: panel.lastFrameSourceMeta,
    }))

    await replaceSixGridSheet(input, store)
    const state = store.snapshot()

    expect(state.storyboard).toMatchObject(preservedStoryboard)
    expect(state.panels.map((panel) => ({
      id: panel.id,
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
      panelNumber: panel.panelNumber,
      description: panel.description,
      imagePrompt: panel.imagePrompt,
      hasDialogue: panel.hasDialogue,
      dialogueSpeaker: panel.dialogueSpeaker,
      dialogueText: panel.dialogueText,
      dialogueEmotion: panel.dialogueEmotion,
      duration: panel.duration,
      estimatedDuration: panel.estimatedDuration,
      durationOverride: panel.durationOverride,
      videoPrompt: panel.videoPrompt,
      firstLastFramePrompt: panel.firstLastFramePrompt,
      videoUrl: panel.videoUrl,
      videoMediaId: panel.videoMediaId,
      videoGenerationMode: panel.videoGenerationMode,
      photographyRules: panel.photographyRules,
      actingNotes: panel.actingNotes,
      linkedToNextPanel: panel.linkedToNextPanel,
      firstFrameSourceMeta: panel.firstFrameSourceMeta,
      lastFrameSourceMeta: panel.lastFrameSourceMeta,
    }))).toEqual(preservedPanels)
  })

  it('returns the installed sheet values read from inside the transaction', async () => {
    const store = new InMemorySixGridUploadStore(createState(), {
      sheetImageMediaId: 'media-read-back',
      sheetImageUrl: 'https://cdn.example/read-back.png',
      sheetArtifactVersion: 5,
    })

    await expect(replaceSixGridSheet(input, store)).resolves.toEqual({
      mediaId: 'media-read-back',
      url: 'https://cdn.example/read-back.png',
      sheetArtifactVersion: 5,
    })
  })

  it('maps a Prisma serialization conflict to the stable stale-upload conflict', async () => {
    const store: SixGridUploadStore = {
      findActiveTask: async () => null,
      transaction: async () => {
        throw Object.assign(new Error('Transaction failed due to a write conflict'), { code: 'P2034' })
      },
    }

    const error = await captureError(() => replaceSixGridSheet(input, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_STALE')
  })

  it('does not remap unrelated transaction failures', async () => {
    const failure = Object.assign(new Error('database unavailable'), { code: 'P1001' })
    const store: SixGridUploadStore = {
      findActiveTask: async () => null,
      transaction: async () => { throw failure },
    }

    await expect(replaceSixGridSheet(input, store)).rejects.toBe(failure)
  })

  it('rejects a stale artifact version without changing the fixture', async () => {
    const store = new InMemorySixGridUploadStore(createState())
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet({
      ...input,
      expectedSheetArtifactVersion: 3,
    }, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_STALE')
    expect(store.snapshot()).toEqual(before)
    expect(JSON.stringify(store.snapshot())).toBe(JSON.stringify(before))
  })

  it.each([
    ['user ownership', { userId: 'user-other' }],
    ['project ownership', { projectId: 'project-other' }],
    ['episode ownership', { episodeId: 'episode-other' }],
  ])('rejects wrong %s without changing the fixture', async (_label, ownership) => {
    const store = new InMemorySixGridUploadStore(createState())
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet({ ...input, ...ownership }, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_STALE')
    expect(store.snapshot()).toEqual(before)
  })

  it('rejects a non-six-grid storyboard without changing the fixture', async () => {
    const state = createState()
    state.storyboard.layoutMode = 'individual'
    const store = new InMemorySixGridUploadStore(state)
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet(input, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_STALE')
    expect(store.snapshot()).toEqual(before)
  })

  it.each([5, 7])('rolls back both storyboard and panel changes when the set has %i panels', async (panelCount) => {
    const store = new InMemorySixGridUploadStore(createState(panelCount))
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet(input, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_PANEL_SET_CHANGED')
    expect(store.snapshot()).toEqual(before)
    expect(JSON.stringify(store.snapshot())).toBe(JSON.stringify(before))
  })

  it.each([
    [TASK_TYPE.STORYBOARD_SHEET_GENERATE, TASK_STATUS.QUEUED],
    [TASK_TYPE.STORYBOARD_SHEET_UPSCALE, TASK_STATUS.QUEUED],
    [TASK_TYPE.STORYBOARD_SHEET_CROP, TASK_STATUS.QUEUED],
    [TASK_TYPE.STORYBOARD_SHEET_GENERATE, TASK_STATUS.PROCESSING],
    [TASK_TYPE.STORYBOARD_SHEET_UPSCALE, TASK_STATUS.PROCESSING],
    [TASK_TYPE.STORYBOARD_SHEET_CROP, TASK_STATUS.PROCESSING],
  ])('rejects active %s work in %s status before entering the transaction', async (type, status) => {
    const state = createState()
    state.tasks.push(activeTask(type, status))
    const store = new InMemorySixGridUploadStore(state)
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet(input, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_BUSY')
    expect(store.transactionCount).toBe(0)
    expect(store.snapshot()).toEqual(before)
  })

  it('rejects a task that appears after the preflight check but before replacement writes', async () => {
    const store = new InMemorySixGridUploadStore(createState(), undefined, (state) => {
      state.tasks.push(activeTask(TASK_TYPE.STORYBOARD_SHEET_GENERATE, TASK_STATUS.QUEUED))
    })
    const before = store.snapshot()

    const error = await captureError(() => replaceSixGridSheet(input, store))

    expectConflict(error, 'SIX_GRID_UPLOAD_BUSY')
    expect(store.storyboardWriteCount).toBe(0)
    expect(store.panelWriteCount).toBe(0)
    expect(store.snapshot().storyboard).toEqual(before.storyboard)
    expect(store.snapshot().panels).toEqual(before.panels)
  })

  it('does not block replacement for a terminal sheet task', async () => {
    const state = createState()
    state.tasks.push(activeTask(TASK_TYPE.STORYBOARD_SHEET_GENERATE, TASK_STATUS.COMPLETED))
    const store = new InMemorySixGridUploadStore(state)

    await expect(replaceSixGridSheet(input, store)).resolves.toMatchObject({
      mediaId: input.media.id,
      sheetArtifactVersion: 5,
    })
    expect(store.snapshot().storyboard.sheetImageMediaId).toBe(input.media.id)
  })

  it('queries availability with the complete owner, target, type, and active-status fence', async () => {
    const store = new InMemorySixGridUploadStore(createState())

    await assertSixGridUploadAvailable(input, store)

    expect(store.lastAvailabilityQuery).toEqual({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        episodeId: input.episodeId,
        targetType: 'NovelPromotionStoryboard',
        targetId: input.storyboardId,
        type: {
          in: [
            TASK_TYPE.STORYBOARD_SHEET_GENERATE,
            TASK_TYPE.STORYBOARD_SHEET_UPSCALE,
            TASK_TYPE.STORYBOARD_SHEET_CROP,
          ],
        },
        status: { in: [TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING] },
      },
      select: { id: true },
    })
  })
})
