'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { queryKeys } from '../keys'
import {
  createViralReplicationSession,
  generateViralReplicationClient,
  getViralReplicationDetail,
  patchViralReplicationBrief,
  retryViralReplicationClient,
  type ViralReplicationDetail,
} from '@/lib/viral-replication/client'

export function mergeViralReplicationDetail(
  previous: ViralReplicationDetail | undefined,
  incoming: ViralReplicationDetail,
): ViralReplicationDetail {
  if (!previous || previous.id !== incoming.id) return incoming
  return { ...previous, ...incoming }
}

function updateCachedViralReplication(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
  replication: ViralReplicationDetail,
) {
  const queryKey = queryKeys.viralReplication.detail(id)
  const previous = queryClient.getQueryData<ViralReplicationDetail>(queryKey)
  if (!previous) {
    void queryClient.invalidateQueries({ queryKey })
    return
  }
  queryClient.setQueryData<ViralReplicationDetail>(queryKey, mergeViralReplicationDetail(previous, replication))
}

export function useViralReplication(id: string | null) {
  return useQuery({
    queryKey: queryKeys.viralReplication.detail(id || ''),
    queryFn: async () => {
      if (!id) throw new Error('Viral replication ID is required')
      return await getViralReplicationDetail(id)
    },
    enabled: !!id,
    staleTime: 1_000,
  })
}

export function useCreateViralReplication() {
  return useMutation({ mutationFn: createViralReplicationSession })
}

export function usePatchViralReplicationBrief(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (brief: string) => patchViralReplicationBrief(id, brief),
    onSuccess: (replication) => {
      updateCachedViralReplication(queryClient, id, replication)
    },
  })
}

export function useRetryViralReplication(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => retryViralReplicationClient(id),
    onSuccess: (replication) => {
      updateCachedViralReplication(queryClient, id, replication)
    },
  })
}

export function useGenerateViralReplication(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (brief: string) => generateViralReplicationClient(id, brief),
    onSuccess: (replication) => {
      updateCachedViralReplication(queryClient, id, replication)
    },
  })
}
