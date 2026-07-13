export type FrameSourceMode = 'automatic' | 'manual'

export interface FrameSourceMeta {
  mode: FrameSourceMode
  sourcePanelId: string
}

export interface FrameLinkPanel {
  id: string
  storyboardId: string
  panelIndex: number
  gridCellIndex?: number | null
  firstFrameSourceMeta?: string | null
  lastFrameSourceMeta?: string | null
  linkedToNextPanel?: boolean | null
}

export interface FlatFrameLinkPanel extends FrameLinkPanel {
  layoutMode?: string | null
  groupSequence?: number | null
  continuityAnchor?: string | null
  storyboardCreatedAt?: Date | string | null
  clipCreatedAt?: Date | string | null
}

export interface FrameLinkStoryboard {
  id: string
  layoutMode?: string | null
  groupSequence?: number | null
  continuityAnchor?: string | null
  createdAt?: Date | string | null
  clipCreatedAt?: Date | string | null
  panels: FrameLinkPanel[]
}

export interface FrameLinkChoices {
  firstFrame: FrameSourceMeta | null
  lastFrame: FrameSourceMeta | null
}

export function groupFrameLinkPanels(panels: FlatFrameLinkPanel[]): FrameLinkStoryboard[] {
  const groups = new Map<string, FrameLinkStoryboard>()
  for (const panel of panels) {
    const existing = groups.get(panel.storyboardId)
    if (existing) {
      existing.panels.push(panel)
      continue
    }
    groups.set(panel.storyboardId, {
      id: panel.storyboardId,
      layoutMode: panel.layoutMode,
      groupSequence: panel.groupSequence,
      continuityAnchor: panel.continuityAnchor,
      createdAt: panel.storyboardCreatedAt,
      clipCreatedAt: panel.clipCreatedAt,
      panels: [panel],
    })
  }
  return [...groups.values()]
}

type ParsedFrameSourceMeta = FrameSourceMeta | null | undefined

export function parseFrameSourceMeta(raw: string | null | undefined): ParsedFrameSourceMeta {
  if (raw == null || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null) return null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if ((record.mode !== 'automatic' && record.mode !== 'manual')
      || typeof record.sourcePanelId !== 'string'
      || !record.sourcePanelId.trim()) {
      return undefined
    }
    return {
      mode: record.mode,
      sourcePanelId: record.sourcePanelId,
    }
  } catch {
    return undefined
  }
}

export function serializeFrameSourceMeta(meta: FrameSourceMeta | null): string {
  return JSON.stringify(meta)
}

function readSceneKey(storyboard: FrameLinkStoryboard): string | null {
  if (!storyboard.continuityAnchor) return null
  try {
    const parsed: unknown = JSON.parse(storyboard.continuityAnchor)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const sceneKey = (parsed as Record<string, unknown>).sceneKey
    return typeof sceneKey === 'string' && sceneKey.trim() ? sceneKey.trim() : null
  } catch {
    return null
  }
}

function sortedPanels(storyboard: FrameLinkStoryboard): FrameLinkPanel[] {
  return [...storyboard.panels].sort((left, right) => {
    const leftOrder = storyboard.layoutMode === 'six_grid'
      ? left.gridCellIndex ?? left.panelIndex
      : left.panelIndex
    const rightOrder = storyboard.layoutMode === 'six_grid'
      ? right.gridCellIndex ?? right.panelIndex
      : right.panelIndex
    return leftOrder - rightOrder
  })
}

function timestamp(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string' || !value) return null
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function canonicalStoryboards(storyboards: FrameLinkStoryboard[]): FrameLinkStoryboard[] {
  return storyboards
    .map((storyboard, index) => ({ storyboard, index }))
    .sort((left, right) => {
      const leftClip = timestamp(left.storyboard.clipCreatedAt)
      const rightClip = timestamp(right.storyboard.clipCreatedAt)
      if (leftClip != null || rightClip != null) {
        if (leftClip == null) return 1
        if (rightClip == null) return -1
        if (leftClip !== rightClip) return leftClip - rightClip
      }
      const leftCreated = timestamp(left.storyboard.createdAt)
      const rightCreated = timestamp(right.storyboard.createdAt)
      if (leftCreated != null || rightCreated != null) {
        if (leftCreated == null) return 1
        if (rightCreated == null) return -1
        if (leftCreated !== rightCreated) return leftCreated - rightCreated
      }
      if (leftClip != null || rightClip != null || leftCreated != null || rightCreated != null) {
        return left.storyboard.id.localeCompare(right.storyboard.id)
      }
      return left.index - right.index
    })
    .map(({ storyboard }) => storyboard)
}

function resolveStoredChoice(
  raw: string | null | undefined,
  automatic: FrameSourceMeta | null,
  ownedPanelIds: Set<string>,
): FrameSourceMeta | null {
  const stored = parseFrameSourceMeta(raw)
  if (stored === null) return null
  if (stored?.mode === 'manual') {
    return ownedPanelIds.has(stored.sourcePanelId) ? stored : null
  }
  return automatic
}

export interface FrameLinkResolutionIndex {
  choicesByPanelId: Map<string, FrameLinkChoices>
  automaticChoicesByPanelId: Map<string, FrameLinkChoices>
  panelById: Map<string, FrameLinkPanel>
  incomingSourcePanelIdsByPanelId: Map<string, string[]>
}

export function buildFrameLinkResolutionIndex(input: {
  storyboards: FrameLinkStoryboard[]
  restoreLegacyAuto?: boolean
  onPanelVisit?: (panel: FrameLinkPanel) => void
}): FrameLinkResolutionIndex {
  const storyboards = canonicalStoryboards(input.storyboards)
  const panelsByStoryboard = new Map<string, FrameLinkPanel[]>()
  const panelById = new Map<string, FrameLinkPanel>()
  const ownedPanelIds = new Set<string>()

  for (const storyboard of storyboards) {
    const panels = sortedPanels(storyboard)
    panelsByStoryboard.set(storyboard.id, panels)
    for (const panel of panels) {
      panelById.set(panel.id, panel)
      ownedPanelIds.add(panel.id)
    }
  }

  const orderedSixGridGroups = storyboards
    .filter((storyboard) => storyboard.layoutMode === 'six_grid')
    .filter((storyboard) => typeof storyboard.groupSequence === 'number')
    .sort((left, right) => (
      (left.groupSequence ?? 0) - (right.groupSequence ?? 0)
      || left.id.localeCompare(right.id)
    ))
  const nextSixGridGroupById = new Map<string, FrameLinkStoryboard>()
  orderedSixGridGroups.forEach((storyboard, index) => {
    const next = orderedSixGridGroups[index + 1]
    if (next) nextSixGridGroupById.set(storyboard.id, next)
  })
  const storyboardIndexById = new Map(storyboards.map((storyboard, index) => [storyboard.id, index]))

  const automaticLastByPanelId = new Map<string, FrameSourceMeta | null>()
  for (const storyboard of storyboards) {
    const panels = panelsByStoryboard.get(storyboard.id) || []
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex += 1) {
      const panel = panels[panelIndex]
      input.onPanelVisit?.(panel)
      const withinStoryboard = panels[panelIndex + 1]
      if (withinStoryboard) {
        automaticLastByPanelId.set(panel.id, { mode: 'automatic', sourcePanelId: withinStoryboard.id })
        continue
      }
      if (storyboard.layoutMode === 'six_grid') {
        const nextGroup = nextSixGridGroupById.get(storyboard.id)
        const currentSceneKey = readSceneKey(storyboard)
        const nextSceneKey = nextGroup ? readSceneKey(nextGroup) : null
        const nextPanel = nextGroup ? panelsByStoryboard.get(nextGroup.id)?.[0] : undefined
        automaticLastByPanelId.set(
          panel.id,
          nextPanel && currentSceneKey && nextSceneKey && currentSceneKey === nextSceneKey
            ? { mode: 'automatic', sourcePanelId: nextPanel.id }
            : null,
        )
        continue
      }
      const hasFrameSourceMetadata = panel.firstFrameSourceMeta != null
        || panel.lastFrameSourceMeta != null
      const canExplicitlyRestoreLegacy = input.restoreLegacyAuto === true
        && (storyboard.layoutMode == null || storyboard.layoutMode === 'individual')
      const storyboardIndex = storyboardIndexById.get(storyboard.id) ?? -1
      const nextStoryboard = storyboardIndex >= 0 ? storyboards[storyboardIndex + 1] : undefined
      const nextPanel = nextStoryboard && nextStoryboard.layoutMode !== 'six_grid'
        ? panelsByStoryboard.get(nextStoryboard.id)?.[0]
        : undefined
      automaticLastByPanelId.set(
        panel.id,
        (panel.linkedToNextPanel === true || canExplicitlyRestoreLegacy) && !hasFrameSourceMetadata && nextPanel
          ? { mode: 'automatic', sourcePanelId: nextPanel.id }
          : null,
      )
    }
  }

  const choicesByPanelId = new Map<string, FrameLinkChoices>()
  const automaticChoicesByPanelId = new Map<string, FrameLinkChoices>()
  const incomingSourcePanelIdsByPanelId = new Map<string, string[]>()
  for (const [panelId, panel] of panelById) {
    const automaticFirst: FrameSourceMeta = { mode: 'automatic', sourcePanelId: panelId }
    const automaticLast = automaticLastByPanelId.get(panelId) ?? null
    const automaticChoices = { firstFrame: automaticFirst, lastFrame: automaticLast }
    const choices = {
      firstFrame: resolveStoredChoice(panel.firstFrameSourceMeta, automaticFirst, ownedPanelIds),
      lastFrame: resolveStoredChoice(panel.lastFrameSourceMeta, automaticLast, ownedPanelIds),
    }
    automaticChoicesByPanelId.set(panelId, automaticChoices)
    choicesByPanelId.set(panelId, choices)
    if (choices.lastFrame) {
      const incoming = incomingSourcePanelIdsByPanelId.get(choices.lastFrame.sourcePanelId) || []
      incoming.push(panelId)
      incomingSourcePanelIdsByPanelId.set(choices.lastFrame.sourcePanelId, incoming)
    }
  }

  return {
    choicesByPanelId,
    automaticChoicesByPanelId,
    panelById,
    incomingSourcePanelIdsByPanelId,
  }
}

export function resolveFrameLinkChoices(input: {
  panelId: string
  storyboards: FrameLinkStoryboard[]
  restoreLegacyAuto?: boolean
}): FrameLinkChoices {
  return buildFrameLinkResolutionIndex({
    storyboards: input.storyboards,
    restoreLegacyAuto: input.restoreLegacyAuto,
  }).choicesByPanelId.get(input.panelId) || { firstFrame: null, lastFrame: null }
}

export function resolveAutomaticFrameLinkChoices(input: {
  panelId: string
  storyboards: FrameLinkStoryboard[]
}): FrameLinkChoices {
  return buildFrameLinkResolutionIndex({ storyboards: input.storyboards })
    .automaticChoicesByPanelId.get(input.panelId) || { firstFrame: null, lastFrame: null }
}

export function resolveFrameLinkSubmission(input: {
  choices: FrameLinkChoices
  supportsFirstLastFrame: boolean
}) {
  if (!input.supportsFirstLastFrame) {
    return {
      choices: input.choices,
      submission: null,
      diagnostic: 'FIRST_LAST_FRAME_MODEL_UNSUPPORTED' as const,
    }
  }
  if (!input.choices.firstFrame || !input.choices.lastFrame) {
    return {
      choices: input.choices,
      submission: null,
      diagnostic: 'FIRST_LAST_FRAME_SOURCE_MISSING' as const,
    }
  }
  return {
    choices: input.choices,
    submission: {
      firstFrameSourcePanelId: input.choices.firstFrame.sourcePanelId,
      lastFrameSourcePanelId: input.choices.lastFrame.sourcePanelId,
    },
    diagnostic: null,
  }
}
