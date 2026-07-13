import { ApiError } from '@/lib/api-errors'

type UndoPanel = {
  id: string
  imageMediaId: string | null
  imageUrl: string | null
  previousImageMediaId: string | null
  previousImageUrl: string | null
  croppedImageMediaId: string | null
  upscaledImageMediaId: string | null
}

type PanelUndoTransaction = {
  novelPromotionPanel: {
    findFirst: (args: unknown) => Promise<UndoPanel | null>
    updateMany: (args: unknown) => Promise<{ count: number }>
  }
}

export type PanelUndoClient = {
  $transaction: <T>(callback: (tx: PanelUndoTransaction) => Promise<T>) => Promise<T>
}

export async function undoSixGridPanelImage(client: PanelUndoClient, input: {
  projectId: string
  panelId: string
  expectedCurrentMediaId: string
  expectedPreviousMediaId: string
}) {
  return client.$transaction(async (tx) => {
    const panel = await tx.novelPromotionPanel.findFirst({
      where: {
        id: input.panelId,
        storyboard: { episode: { novelPromotionProject: { projectId: input.projectId } } },
      },
      select: {
        id: true, imageMediaId: true, imageUrl: true,
        previousImageMediaId: true, previousImageUrl: true,
        croppedImageMediaId: true, upscaledImageMediaId: true,
      },
    })
    if (!panel) throw new Error('SIX_GRID_PANEL_NOT_FOUND')
    if (!panel.previousImageMediaId || !panel.previousImageUrl) throw new Error('PREVIOUS_PANEL_IMAGE_REQUIRED')
    if (panel.imageMediaId !== input.expectedCurrentMediaId
      || panel.previousImageMediaId !== input.expectedPreviousMediaId) {
      throw new Error('SIX_GRID_PANEL_IMAGE_STALE')
    }
    const previousDerivation = panel.previousImageMediaId === panel.croppedImageMediaId
      ? 'six_grid_crop'
      : panel.previousImageMediaId === panel.upscaledImageMediaId ? 'panel_upscale' : null
    const result = await tx.novelPromotionPanel.updateMany({
      where: {
        id: panel.id,
        imageMediaId: input.expectedCurrentMediaId,
        previousImageMediaId: input.expectedPreviousMediaId,
      },
      data: {
        imageMediaId: panel.previousImageMediaId,
        imageUrl: panel.previousImageUrl,
        previousImageMediaId: panel.imageMediaId,
        previousImageUrl: panel.imageUrl,
        imageDerivation: previousDerivation,
        imageLineage: null,
      },
    })
    if (result.count !== 1) throw new Error('SIX_GRID_PANEL_IMAGE_STALE')
    return { success: true }
  })
}

export function toPanelUndoApiError(error: unknown): ApiError {
  const code = error instanceof Error ? error.message : ''
  if (code === 'SIX_GRID_PANEL_IMAGE_STALE') return new ApiError('CONFLICT', { code })
  if (code === 'PREVIOUS_PANEL_IMAGE_REQUIRED') return new ApiError('INVALID_PARAMS', { code, field: 'panelId' })
  if (code === 'SIX_GRID_PANEL_NOT_FOUND') return new ApiError('NOT_FOUND')
  if (error instanceof ApiError) return error
  throw error
}
