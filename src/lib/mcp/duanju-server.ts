import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiError } from '@/lib/api-errors'
import type { DuanjuMcpPrincipal } from '@/lib/mcp/duanju-auth'
import {
  createDuanjuEpisode,
  createDuanjuProject,
  getDuanjuEpisode,
  getDuanjuProject,
  importDuanjuStoryboards,
  listDuanjuProjects,
  listDuanjuTasks,
  updateDuanjuEpisode,
  upsertDuanjuCharacter,
  upsertDuanjuLocation,
} from '@/lib/mcp/duanju-service'
import {
  externalStoryboardGroupSchema,
  externalStoryboardImportSchema,
} from '@/lib/novel-promotion/external-storyboard-import'

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

async function executeTool(operation: () => Promise<unknown>) {
  try {
    const value = await operation()
    return {
      content: [{ type: 'text' as const, text: jsonText(value) }],
    }
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : 'Unknown MCP tool error'
    return {
      isError: true,
      content: [{
        type: 'text' as const,
        text: jsonText({ error: code, message }),
      }],
    }
  }
}

const idSchema = z.string().trim().min(1).max(200)
const nullableTextSchema = z.string().max(200_000).nullable()

export function createDuanjuMcpServer(principal: DuanjuMcpPrincipal) {
  const server = new McpServer({
    name: 'duanju',
    version: '1.0.0',
  })

  server.registerTool('duanju_list_projects', {
    title: '列出短剧项目',
    description: '列出当前 MCP 用户拥有的短剧项目。',
    inputSchema: z.object({
      query: z.string().trim().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ query, limit }) => executeTool(() => listDuanjuProjects({
    userId: principal.userId,
    query,
    limit,
  })))

  server.registerTool('duanju_get_project', {
    title: '读取短剧项目',
    description: '读取项目配置、剧集摘要、人物和场景/道具资产。',
    inputSchema: z.object({ projectId: idSchema }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ projectId }) => executeTool(() => getDuanjuProject(principal.userId, projectId)))

  server.registerTool('duanju_get_episode', {
    title: '读取剧集与分镜',
    description: '读取一集的剧本、片段、宫格分镜、面板提示词、台词和媒体引用。',
    inputSchema: z.object({
      projectId: idSchema,
      episodeId: idSchema,
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ projectId, episodeId }) => executeTool(() => getDuanjuEpisode({
    userId: principal.userId,
    projectId,
    episodeId,
  })))

  server.registerTool('duanju_create_project', {
    title: '创建短剧项目',
    description: '在当前 MCP 用户下创建短剧项目，并继承该用户的默认模型配置。',
    inputSchema: z.object({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().max(2_000).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ name, description }) => executeTool(() => createDuanjuProject({
    userId: principal.userId,
    name,
    description,
  })))

  server.registerTool('duanju_create_episode', {
    title: '创建短剧剧集',
    description: '在项目中创建新剧集，可同时写入原始剧本。',
    inputSchema: z.object({
      projectId: idSchema,
      name: z.string().trim().min(1).max(500),
      description: z.string().trim().max(20_000).optional(),
      novelText: z.string().max(200_000).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ projectId, name, description, novelText }) => executeTool(() => createDuanjuEpisode({
    userId: principal.userId,
    projectId,
    name,
    description,
    novelText,
  })))

  server.registerTool('duanju_update_episode', {
    title: '更新短剧剧集',
    description: '更新剧集标题、简介、剧本正文或字幕。未提供的字段保持不变。',
    inputSchema: z.object({
      projectId: idSchema,
      episodeId: idSchema,
      name: z.string().trim().min(1).max(500).optional(),
      description: nullableTextSchema.optional(),
      novelText: nullableTextSchema.optional(),
      srtContent: nullableTextSchema.optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ projectId, episodeId, ...updates }) => executeTool(() => updateDuanjuEpisode({
    userId: principal.userId,
    projectId,
    episodeId,
    ...updates,
  })))

  server.registerTool('duanju_upsert_character', {
    title: '新增或更新角色资产',
    description: '不传 characterId 时新增角色；传入时更新已有角色。可同步写入初始形象提示词。',
    inputSchema: z.object({
      projectId: idSchema,
      characterId: idSchema.optional(),
      name: z.string().trim().min(1).max(500),
      introduction: z.string().trim().max(20_000).optional(),
      aliases: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      appearanceDescription: z.string().trim().max(30_000).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ projectId, characterId, name, introduction, aliases, appearanceDescription }) =>
    executeTool(() => upsertDuanjuCharacter({
      userId: principal.userId,
      projectId,
      characterId,
      name,
      introduction,
      aliases,
      appearanceDescription,
    })))

  server.registerTool('duanju_upsert_location', {
    title: '新增或更新场景/道具资产',
    description: '新增或更新场景、道具及其首张图片的生成提示词。',
    inputSchema: z.object({
      projectId: idSchema,
      locationId: idSchema.optional(),
      name: z.string().trim().min(1).max(500),
      summary: z.string().trim().max(20_000).optional(),
      assetKind: z.enum(['location', 'prop']).default('location'),
      imageDescription: z.string().trim().max(30_000).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, ({ projectId, locationId, name, summary, assetKind, imageDescription }) =>
    executeTool(() => upsertDuanjuLocation({
      userId: principal.userId,
      projectId,
      locationId,
      name,
      summary,
      assetKind,
      imageDescription,
    })))

  server.registerTool('duanju_import_grid_storyboards', {
    title: '导入外部分析生成的宫格分镜',
    description: '把 Codex 分析出的四宫格或六宫格规划写入剧集。会替换该剧集已有片段、分镜和面板。',
    inputSchema: z.object({
      projectId: idSchema,
      episodeId: idSchema,
      title: z.string().trim().min(1).max(500).optional(),
      replaceExisting: z.literal(true),
      groups: z.array(externalStoryboardGroupSchema).min(1).max(30),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, ({ projectId, episodeId, title, replaceExisting, groups }) => executeTool(async () => {
    const data = externalStoryboardImportSchema.parse({
      episodeId,
      title,
      replaceExisting,
      groups,
    })
    return importDuanjuStoryboards({
      userId: principal.userId,
      projectId,
      data,
    })
  }))

  server.registerTool('duanju_list_tasks', {
    title: '查看短剧任务状态',
    description: '读取项目最近的生成任务、进度、错误码和心跳时间，用于定位卡住的任务。',
    inputSchema: z.object({
      projectId: idSchema,
      episodeId: idSchema.optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ projectId, episodeId, limit }) => executeTool(() => listDuanjuTasks({
    userId: principal.userId,
    projectId,
    episodeId,
    limit,
  })))

  return server
}
