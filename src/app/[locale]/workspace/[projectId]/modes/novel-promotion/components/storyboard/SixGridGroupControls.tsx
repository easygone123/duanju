'use client'

import React from 'react'
import GridGroupControls, {
  type GridGroupControlsProps,
  type GridUpscaleWorkflow,
} from './GridGroupControls'

export type SixGridUpscaleWorkflow = GridUpscaleWorkflow

export default function SixGridGroupControls(props: GridGroupControlsProps) {
  if (props.storyboard.layoutMode !== 'six_grid') return null
  return <GridGroupControls {...props} translationNamespace="storyboard.sixGrid" />
}
