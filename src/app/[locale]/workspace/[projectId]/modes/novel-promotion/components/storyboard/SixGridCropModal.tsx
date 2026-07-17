'use client'

import React from 'react'
import GridCropModal, { type GridCropModalProps } from './GridCropModal'

export {
  adjustCropRect,
  buildCropSubmission,
  getCropSourceOptions,
  pointerDeltaToNormalized,
  resetCropRects,
  resizeCropFromBottomRight,
} from './GridCropModal'
export type { CropEntry, CropSourceKind } from './GridCropModal'

export default function SixGridCropModal(props: GridCropModalProps) {
  return <GridCropModal {...props} translationNamespace="storyboard.sixGrid" />
}
