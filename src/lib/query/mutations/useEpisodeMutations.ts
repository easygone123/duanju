import { useRef } from 'react'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Project } from '@/types/project'
import { resolveTaskResponse } from '@/lib/task/client'
import { queryKeys } from '../keys'
import { invalidateEpisodeStageQueries } from '../episode-stage-cache'
import {
  invalidateQueryTemplates,
  requestBlobWithError,
  requestJsonWithError,
  requestTaskResponseWithError,
} from './mutation-shared'

type EpisodeFieldVariables = {
  episodeId: string
  key: string
  value: unknown
}

type EpisodeFieldCacheSnapshot = {
  previousEpisode: Record<string, unknown> | undefined
  previousProject: Project | undefined
  previousConfig: Record<string, unknown> | undefined
}

type NovelTextTransaction = {
  firstVersion: number
  latestVersion: number
  confirmedVersion: number
  confirmed: EpisodeFieldCacheSnapshot
  variablesByVersion: Map<number, EpisodeFieldVariables>
  requestsByVersion: Map<number, Promise<unknown>>
}

type NovelTextMutationMeta = {
  transaction: NovelTextTransaction
  version: number
  dispatchedVersion?: number
}

const novelTextTransactionsByClient = new WeakMap<
  QueryClient,
  Map<string, Map<string, NovelTextTransaction>>
>()

function getNovelTextTransactions(queryClient: QueryClient, projectId: string) {
  let clientTransactions = novelTextTransactionsByClient.get(queryClient)
  if (!clientTransactions) {
    clientTransactions = new Map()
    novelTextTransactionsByClient.set(queryClient, clientTransactions)
  }
  let projectTransactions = clientTransactions.get(projectId)
  if (!projectTransactions) {
    projectTransactions = new Map()
    clientTransactions.set(projectId, projectTransactions)
  }
  return projectTransactions
}

function deleteNovelTextTransaction(
  queryClient: QueryClient,
  projectId: string,
  episodeId: string,
  transaction: NovelTextTransaction,
) {
  const clientTransactions = novelTextTransactionsByClient.get(queryClient)
  const projectTransactions = clientTransactions?.get(projectId)
  if (projectTransactions?.get(episodeId) !== transaction) return
  projectTransactions.delete(episodeId)
  if (projectTransactions.size === 0) clientTransactions?.delete(projectId)
  if (clientTransactions?.size === 0) novelTextTransactionsByClient.delete(queryClient)
}

function confirmEpisodeFieldValue(
  snapshot: EpisodeFieldCacheSnapshot,
  variables: EpisodeFieldVariables,
): EpisodeFieldCacheSnapshot {
  const configEpisode = snapshot.previousConfig?.episode
  const projectEpisodes = snapshot.previousProject?.novelPromotionData?.episodes

  return {
    previousEpisode: snapshot.previousEpisode
      ? { ...snapshot.previousEpisode, [variables.key]: variables.value }
      : undefined,
    previousProject: snapshot.previousProject?.novelPromotionData && Array.isArray(projectEpisodes)
      ? {
          ...snapshot.previousProject,
          novelPromotionData: {
            ...snapshot.previousProject.novelPromotionData,
            episodes: projectEpisodes.map((episode) =>
              episode.id === variables.episodeId
                ? { ...episode, [variables.key]: variables.value }
                : episode,
            ),
          },
        }
      : snapshot.previousProject,
    previousConfig: snapshot.previousConfig && configEpisode && typeof configEpisode === 'object'
      ? {
          ...snapshot.previousConfig,
          episode: {
            ...configEpisode as Record<string, unknown>,
            [variables.key]: variables.value,
          },
        }
      : snapshot.previousConfig,
  }
}

/**
 * 获取项目剧集列表
 */
export function useListProjectEpisodes(projectId: string) {
  return useMutation({
    mutationFn: async () =>
      await requestJsonWithError<{
        episodes?: Array<{
          episodeNumber?: number
          name?: string
          description?: string
          novelText?: string
        }>
      }>(`/api/novel-promotion/${projectId}/episodes`, { method: 'GET' }, '获取剧集失败'),
  })
}

/**
 * AI 智能分割剧集
 */
export function useSplitProjectEpisodes(projectId: string) {
  return useMutation({
    mutationFn: async (payload: { content: string; async?: boolean }) => {
      const response = await requestTaskResponseWithError(
        `/api/novel-promotion/${projectId}/episodes/split`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '分割失败',
      )
      return resolveTaskResponse<{
        episodes: Array<{
          number: number
          title: string
          summary: string
          content: string
          wordCount: number
        }>
      }>(response)
    },
  })
}

/**
 * 使用章节标记分割剧集
 */
export function useSplitProjectEpisodesByMarkers(projectId: string) {
  return useMutation({
    mutationFn: async (payload: { content: string }) =>
      await requestJsonWithError<{
        episodes?: Array<{
          number: number
          title: string
          summary: string
          content: string
          wordCount: number
        }>
      }>(
        `/api/novel-promotion/${projectId}/episodes/split-by-markers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '分割失败',
      ),
  })
}

/**
 * 批量保存项目剧集
 */
export function useSaveProjectEpisodesBatch(projectId: string) {
  return useMutation({
    mutationFn: async (payload: {
      episodes: Array<{
        name: string
        description?: string
        novelText?: string
      }>
      clearExisting?: boolean
      importStatus?: 'pending' | 'completed'
      triggerGlobalAnalysis?: boolean
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/episodes/batch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '保存剧集失败',
      ),
  })
}

/**
 * 更新剧集字段
 */
export function useUpdateProjectEpisodeField(projectId: string) {
  const queryClient = useQueryClient()
  const novelTextMutationMetaRef = useRef(new WeakMap<EpisodeFieldVariables, NovelTextMutationMeta>())

  return useMutation({
    scope: { id: `project-episode-field:${projectId}` },
    mutationFn: async (variables: EpisodeFieldVariables) => {
      const novelTextMeta = novelTextMutationMetaRef.current.get(variables)
      let dispatchedVariables = variables
      let sharedRequest: Promise<unknown> | undefined

      if (variables.key === 'novelText' && novelTextMeta) {
        const { transaction, version } = novelTextMeta
        const dispatchedVersion = transaction.requestsByVersion.has(version)
          || version === transaction.firstVersion
          || version === transaction.latestVersion
          ? version
          : transaction.latestVersion
        novelTextMeta.dispatchedVersion = dispatchedVersion
        dispatchedVariables = transaction.variablesByVersion.get(dispatchedVersion) ?? variables
        sharedRequest = transaction.requestsByVersion.get(dispatchedVersion)
      }

      if (!sharedRequest) {
        sharedRequest = requestJsonWithError(
          `/api/novel-promotion/${projectId}/episodes/${dispatchedVariables.episodeId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [dispatchedVariables.key]: dispatchedVariables.value }),
          },
          'Failed to update episode',
        )
        if (variables.key === 'novelText' && novelTextMeta?.dispatchedVersion !== undefined) {
          novelTextMeta.transaction.requestsByVersion.set(novelTextMeta.dispatchedVersion, sharedRequest)
        }
      }

      return await sharedRequest
    },
    onMutate: async (variables) => {
      const episodeQueryKey = queryKeys.episodeData(projectId, variables.episodeId)
      const projectQueryKey = queryKeys.projectData(projectId)
      const configQueryKey = queryKeys.episodeStage(projectId, variables.episodeId, 'config')

      await queryClient.cancelQueries({ queryKey: episodeQueryKey })
      await queryClient.cancelQueries({ queryKey: projectQueryKey })
      await queryClient.cancelQueries({ queryKey: configQueryKey, exact: true })

      const previousEpisode = queryClient.getQueryData<Record<string, unknown>>(episodeQueryKey)
      const previousProject = queryClient.getQueryData<Project>(projectQueryKey)
      const previousConfig = queryClient.getQueryData<Record<string, unknown>>(configQueryKey)
      let novelTextMeta: NovelTextMutationMeta | undefined

      if (variables.key === 'novelText') {
        const novelTextTransactions = getNovelTextTransactions(queryClient, projectId)
        let transaction = novelTextTransactions.get(variables.episodeId)
        if (!transaction) {
          transaction = {
            firstVersion: 1,
            latestVersion: 0,
            confirmedVersion: 0,
            confirmed: { previousEpisode, previousProject, previousConfig },
            variablesByVersion: new Map(),
            requestsByVersion: new Map(),
          }
          novelTextTransactions.set(variables.episodeId, transaction)
        }
        const version = transaction.latestVersion + 1
        transaction.latestVersion = version
        transaction.variablesByVersion.set(version, variables)
        novelTextMeta = { transaction, version }
        novelTextMutationMetaRef.current.set(variables, novelTextMeta)
      }

      queryClient.setQueryData<Record<string, unknown> | undefined>(episodeQueryKey, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          [variables.key]: variables.value,
        }
      })

      queryClient.setQueryData<Project | undefined>(projectQueryKey, (prev) => {
        if (!prev?.novelPromotionData) return prev
        const episodes = Array.isArray(prev.novelPromotionData.episodes)
          ? prev.novelPromotionData.episodes.map((episode) =>
              episode.id === variables.episodeId ? { ...episode, [variables.key]: variables.value } : episode,
            )
          : prev.novelPromotionData.episodes
        return {
          ...prev,
          novelPromotionData: {
            ...prev.novelPromotionData,
            episodes,
          },
        }
      })

      queryClient.setQueryData<Record<string, unknown> | undefined>(configQueryKey, (prev) => {
        if (!prev || !prev.episode || typeof prev.episode !== 'object') return prev
        return {
          ...prev,
          episode: {
            ...prev.episode as Record<string, unknown>,
            [variables.key]: variables.value,
          },
        }
      })

      return {
        previousEpisode,
        previousProject,
        previousConfig,
        episodeId: variables.episodeId,
        novelTextMeta,
      }
    },
    onSuccess: (_data, variables, context) => {
      if (variables.key !== 'novelText' || !context?.novelTextMeta) return
      const { transaction, version, dispatchedVersion = version } = context.novelTextMeta
      const dispatchedVariables = transaction.variablesByVersion.get(dispatchedVersion) ?? variables
      if (dispatchedVersion > transaction.confirmedVersion) {
        transaction.confirmedVersion = dispatchedVersion
        transaction.confirmed = confirmEpisodeFieldValue(transaction.confirmed, dispatchedVariables)
      }
      if (dispatchedVersion === transaction.latestVersion) {
        deleteNovelTextTransaction(queryClient, projectId, dispatchedVariables.episodeId, transaction)
      }
    },
    onError: (_error, variables, context) => {
      if (!context?.episodeId) return
      const novelTextMeta = context.novelTextMeta
      const dispatchedVersion = novelTextMeta?.dispatchedVersion ?? novelTextMeta?.version
      const failedVariables = novelTextMeta && dispatchedVersion !== undefined
        ? novelTextMeta.transaction.variablesByVersion.get(dispatchedVersion) ?? variables
        : variables
      if (
        variables.key === 'novelText'
        && dispatchedVersion !== novelTextMeta?.transaction.latestVersion
      ) return
      const snapshot = novelTextMeta?.transaction.confirmed ?? context
      const restoreField = (
        current: Record<string, unknown> | undefined,
        previous: Record<string, unknown> | undefined,
      ) => {
        if (!current || current[failedVariables.key] !== failedVariables.value) return current
        const restored = { ...current }
        if (previous && Object.prototype.hasOwnProperty.call(previous, failedVariables.key)) {
          restored[failedVariables.key] = previous[failedVariables.key]
        } else {
          delete restored[failedVariables.key]
        }
        return restored
      }

      queryClient.setQueryData<Record<string, unknown> | undefined>(
        queryKeys.episodeData(projectId, failedVariables.episodeId),
        (current) => restoreField(current, snapshot.previousEpisode),
      )
      queryClient.setQueryData<Project | undefined>(queryKeys.projectData(projectId), (current) => {
        if (!current?.novelPromotionData || !snapshot.previousProject?.novelPromotionData) return current
        const currentEpisodes = current.novelPromotionData.episodes
        const previousEpisodes = snapshot.previousProject.novelPromotionData.episodes
        if (!Array.isArray(currentEpisodes) || !Array.isArray(previousEpisodes)) return current
        return {
          ...current,
          novelPromotionData: {
            ...current.novelPromotionData,
            episodes: currentEpisodes.map((episode) => {
              if (episode.id !== failedVariables.episodeId) return episode
              const previous = previousEpisodes.find((candidate) => candidate.id === failedVariables.episodeId)
              return restoreField(
                episode as unknown as Record<string, unknown>,
                previous as unknown as Record<string, unknown> | undefined,
              ) as unknown as typeof episode
            }),
          },
        }
      })
      queryClient.setQueryData<Record<string, unknown> | undefined>(
        queryKeys.episodeStage(projectId, failedVariables.episodeId, 'config'),
        (current) => {
          if (!current?.episode || typeof current.episode !== 'object') return current
          const previousEpisode = snapshot.previousConfig?.episode
          return {
            ...current,
            episode: restoreField(
              current.episode as Record<string, unknown>,
              previousEpisode && typeof previousEpisode === 'object'
                ? previousEpisode as Record<string, unknown>
                : undefined,
            ),
          }
        },
      )
      if (novelTextMeta) {
        deleteNovelTextTransaction(
          queryClient,
          projectId,
          failedVariables.episodeId,
          novelTextMeta.transaction,
        )
      }
    },
    onSettled: (_, __, variables) => {
      if (variables.key === 'novelText') return
      invalidateQueryTemplates(queryClient, [
        queryKeys.projectData(projectId),
      ])
      void invalidateEpisodeStageQueries(queryClient, projectId, variables.episodeId)
    },
  })
}

/**
 * 更新 clip 数据
 */
export function useUpdateProjectClip(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      clipId,
      data,
    }: {
      clipId: string
      data: Record<string, unknown>
      episodeId?: string
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/clips/${clipId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
        'update failed',
      ),
    onMutate: async (variables) => {
      if (!variables.episodeId) return { previousEpisode: null, episodeId: null }

      const episodeQueryKey = queryKeys.episodeData(projectId, variables.episodeId)
      await queryClient.cancelQueries({ queryKey: episodeQueryKey })

      const previousEpisode = queryClient.getQueryData<Record<string, unknown>>(episodeQueryKey)
      queryClient.setQueryData<Record<string, unknown> | undefined>(episodeQueryKey, (prev) => {
        if (!prev) return prev
        const clips = Array.isArray(prev.clips) ? prev.clips : []
        return {
          ...prev,
          clips: clips.map((clip: Record<string, unknown>) =>
            clip?.id === variables.clipId ? { ...clip, ...variables.data } : clip,
          ),
        }
      })

      return { previousEpisode, episodeId: variables.episodeId }
    },
    onError: (_error, _variables, context) => {
      if (context?.previousEpisode && context.episodeId) {
        queryClient.setQueryData(queryKeys.episodeData(projectId, context.episodeId), context.previousEpisode)
      }
    },
    onSettled: (_data, _error, variables) => {
      const queryTemplates: Array<readonly unknown[]> = [queryKeys.projectData(projectId)]
      invalidateQueryTemplates(queryClient, queryTemplates)
      if (variables.episodeId) {
        void invalidateEpisodeStageQueries(queryClient, projectId, variables.episodeId)
      }
    },
  })
}

/**
 * 下载远程文件 blob（避免组件层直接 fetch）
 */
export function useDownloadRemoteBlob() {
  return useMutation({
    mutationFn: async (url: string) =>
      await requestBlobWithError(
        url,
        { method: 'GET' },
        '下载失败',
      ),
  })
}
