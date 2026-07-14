'use client'

import { useEffect, useMemo } from 'react'
import { logError as _ulogError } from '@/lib/logging/core'
import type { ModelCapabilities } from '@/lib/model-config-contract'
import type { VideoPricingTier } from '@/lib/model-pricing/video-tier'
import type { ComfyWorkflowPurpose } from '@/lib/comfyui/types'
import { useWorkspaceData } from '../WorkspaceDataProvider'

export interface UserModelOption {
  value: string
  label: string
  provider?: string
  providerName?: string
  capabilities?: ModelCapabilities
  videoPricingTiers?: VideoPricingTier[]
  workflowPurpose?: ComfyWorkflowPurpose
  workflowVersionId?: string
}

export interface UserModelsPayload {
  llm: UserModelOption[]
  image: UserModelOption[]
  video: UserModelOption[]
  audio: UserModelOption[]
  lipsync: UserModelOption[]
  upscale: UserModelOption[]
}

export function useWorkspaceUserModels() {
  const sharedData = useWorkspaceData()
  const userModelsForSettings = (sharedData.userModels || null) as UserModelsPayload | null
  const userVideoModels = useMemo<UserModelOption[]>(() => {
    if (!userModelsForSettings || !Array.isArray(userModelsForSettings.video)) return []
    return userModelsForSettings.video
  }, [userModelsForSettings])
  const userUpscaleModels = useMemo<UserModelOption[]>(() => {
    if (!userModelsForSettings || !Array.isArray(userModelsForSettings.upscale)) return []
    return userModelsForSettings.upscale
  }, [userModelsForSettings])
  const userModelsLoaded = sharedData.userModelsLoaded

  useEffect(() => {
    if (sharedData.userModelsError) {
      _ulogError('Failed to fetch user models:', sharedData.userModelsError)
    }
  }, [sharedData.userModelsError])

  return {
    userModelsForSettings,
    userVideoModels,
    userUpscaleModels,
    userModelsLoaded,
  }
}
