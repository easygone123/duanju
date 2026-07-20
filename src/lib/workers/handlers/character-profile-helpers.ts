import { prisma } from '@/lib/prisma'
import { safeParseJsonObject } from '@/lib/json-repair'

export type AnyObj = Record<string, unknown>

export function readText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readRequiredString(value: unknown, field: string): string {
  const text = readText(value).trim()
  if (!text) {
    throw new Error(`${field} is required`)
  }
  return text
}

export function parseVisualResponse(responseText: string): AnyObj {
  return safeParseJsonObject(responseText) as AnyObj
}

export type ParsedCharacterVisualAppearance = {
  changeReason: string
  descriptions: [string, ...string[]]
}

const MIN_CHARACTER_VISUAL_DESCRIPTION_LENGTH = 12

export function parseCharacterVisualAppearances(
  responseText: string,
): ParsedCharacterVisualAppearance[] {
  const visualData = parseVisualResponse(responseText)
  const visualCharacters = Array.isArray(visualData.characters)
    ? (visualData.characters as AnyObj[])
    : []
  const firstCharacter = visualCharacters[0]
  const rawAppearances = Array.isArray(firstCharacter?.appearances)
    ? (firstCharacter.appearances as AnyObj[])
    : []
  if (rawAppearances.length === 0) {
    throw new Error('AI返回格式错误: 缺少 appearances')
  }

  return rawAppearances.map((appearance) => {
    const rawDescriptions = Array.isArray(appearance.descriptions)
      ? appearance.descriptions
      : []
    const descriptions = rawDescriptions.map((item) => readText(item).trim())
    if (
      descriptions.length === 0
      || descriptions.some((description) => description.length < MIN_CHARACTER_VISUAL_DESCRIPTION_LENGTH)
    ) {
      throw new Error('AI返回格式错误: 形象描述无效')
    }
    return {
      changeReason: readText(appearance.change_reason).trim() || '初始形象',
      descriptions: descriptions as [string, ...string[]],
    }
  })
}

export async function resolveProjectModel(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      novelPromotionData: {
        select: {
          id: true,
          analysisModel: true,
        },
      },
    },
  })
  if (!project) throw new Error('Project not found')
  if (!project.novelPromotionData) throw new Error('Novel promotion data not found')
  if (!project.novelPromotionData.analysisModel) throw new Error('请先在项目设置中配置分析模型')
  return project
}
