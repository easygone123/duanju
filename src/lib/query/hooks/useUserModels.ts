'use client'

import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import type { ModelCapabilities } from '@/lib/model-config-contract'
import type { VideoPricingTier } from '@/lib/model-pricing/video-tier'
import type { ComfyWorkflowPurpose } from '@/lib/comfyui/types'
import { queryKeys } from '../keys'
import { apiFetch } from '@/lib/api-fetch'

export interface UserModelOption {
    value: string
    label: string
    provider?: string
    providerName?: string
    capabilities?: ModelCapabilities
    videoPricingTiers?: VideoPricingTier[]
    workflowPurpose?: ComfyWorkflowPurpose
}

export interface UserModelsPayload {
    llm: UserModelOption[]
    image: UserModelOption[]
    video: UserModelOption[]
    audio: UserModelOption[]
    lipsync: UserModelOption[]
    upscale: UserModelOption[]
}

async function fetchUserModels(): Promise<UserModelsPayload> {
    const response = await apiFetch('/api/user/models')
    if (!response.ok) throw new Error('Failed to fetch user models')
    const data = await response.json()
    return {
        llm: Array.isArray(data?.llm) ? data.llm : [],
        image: Array.isArray(data?.image) ? data.image : [],
        video: Array.isArray(data?.video) ? data.video : [],
        audio: Array.isArray(data?.audio) ? data.audio : [],
        lipsync: Array.isArray(data?.lipsync) ? data.lipsync : [],
        upscale: Array.isArray(data?.upscale) ? data.upscale : [],
    }
}

export function userModelsQueryOptions(userId: string) {
    return {
        queryKey: queryKeys.userModels.scope(userId),
        queryFn: fetchUserModels,
    }
}

export function selectImageModelOptions(payload: UserModelsPayload | undefined): UserModelOption[] {
    return payload?.image ?? []
}

export function selectUpscaleModelOptions(payload: UserModelsPayload | undefined): UserModelOption[] {
    return payload?.upscale ?? []
}

export function invalidateUserModels(queryClient: QueryClient) {
    return queryClient.invalidateQueries({ queryKey: queryKeys.userModels.all() })
}

export function useUserModels() {
    const { data: session, status } = useSession()
    const userId = (session?.user as { id?: string } | undefined)?.id ?? session?.user?.email ?? undefined
    return useQuery({
        ...userModelsQueryOptions(userId ?? 'anonymous'),
        enabled: status === 'authenticated' && !!userId,
    })
}
