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
}

export interface FrameLinkStoryboard {
  id: string
  layoutMode?: string | null
  groupSequence?: number | null
  continuityAnchor?: string | null
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

function resolveAutomaticLastFrame(
  panel: FrameLinkPanel,
  storyboard: FrameLinkStoryboard,
  storyboards: FrameLinkStoryboard[],
  restoreLegacyAuto: boolean,
): FrameSourceMeta | null {
  const panels = sortedPanels(storyboard)
  const currentIndex = panels.findIndex((candidate) => candidate.id === panel.id)
  if (currentIndex < 0) return null
  const withinGroup = panels[currentIndex + 1]
  if (withinGroup) return { mode: 'automatic', sourcePanelId: withinGroup.id }
  if (storyboard.layoutMode !== 'six_grid') {
    const hasFrameSourceMetadata = panel.firstFrameSourceMeta != null
      || panel.lastFrameSourceMeta != null
    const canExplicitlyRestoreLegacy = restoreLegacyAuto
      && (storyboard.layoutMode == null || storyboard.layoutMode === 'individual')
    if ((panel.linkedToNextPanel !== true && !canExplicitlyRestoreLegacy) || hasFrameSourceMetadata) return null
    const storyboardIndex = storyboards.findIndex((candidate) => candidate.id === storyboard.id)
    const nextStoryboard = storyboardIndex >= 0 ? storyboards[storyboardIndex + 1] : undefined
    if (!nextStoryboard || nextStoryboard.layoutMode === 'six_grid') return null
    const nextPanel = sortedPanels(nextStoryboard)[0]
    return nextPanel ? { mode: 'automatic', sourcePanelId: nextPanel.id } : null
  }

  const orderedGroups = storyboards
    .filter((candidate) => candidate.layoutMode === 'six_grid')
    .filter((candidate) => typeof candidate.groupSequence === 'number')
    .sort((left, right) => (left.groupSequence ?? 0) - (right.groupSequence ?? 0))
  const groupIndex = orderedGroups.findIndex((candidate) => candidate.id === storyboard.id)
  const nextGroup = groupIndex >= 0 ? orderedGroups[groupIndex + 1] : undefined
  const currentSceneKey = readSceneKey(storyboard)
  const nextSceneKey = nextGroup ? readSceneKey(nextGroup) : null
  if (!nextGroup || !currentSceneKey || !nextSceneKey || currentSceneKey !== nextSceneKey) return null
  const nextPanel = sortedPanels(nextGroup)[0]
  return nextPanel ? { mode: 'automatic', sourcePanelId: nextPanel.id } : null
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

export function resolveFrameLinkChoices(input: {
  panelId: string
  storyboards: FrameLinkStoryboard[]
  restoreLegacyAuto?: boolean
}): FrameLinkChoices {
  const storyboard = input.storyboards.find((candidate) => (
    candidate.panels.some((panel) => panel.id === input.panelId)
  ))
  const panel = storyboard?.panels.find((candidate) => candidate.id === input.panelId)
  if (!storyboard || !panel) return { firstFrame: null, lastFrame: null }

  const ownedPanelIds = new Set(input.storyboards.flatMap((candidate) => (
    candidate.panels.map((item) => item.id)
  )))
  const automaticFirst: FrameSourceMeta = {
    mode: 'automatic',
    sourcePanelId: panel.id,
  }
  const automaticLast = resolveAutomaticLastFrame(
    panel,
    storyboard,
    input.storyboards,
    input.restoreLegacyAuto === true,
  )
  return {
    firstFrame: resolveStoredChoice(panel.firstFrameSourceMeta, automaticFirst, ownedPanelIds),
    lastFrame: resolveStoredChoice(panel.lastFrameSourceMeta, automaticLast, ownedPanelIds),
  }
}

export function resolveAutomaticFrameLinkChoices(input: {
  panelId: string
  storyboards: FrameLinkStoryboard[]
}): FrameLinkChoices {
  return resolveFrameLinkChoices({
    panelId: input.panelId,
    storyboards: input.storyboards.map((storyboard) => ({
      ...storyboard,
      panels: storyboard.panels.map((panel) => panel.id === input.panelId
        ? { ...panel, firstFrameSourceMeta: null, lastFrameSourceMeta: null }
        : panel),
    })),
  })
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
