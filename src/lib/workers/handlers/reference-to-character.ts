import sharp from 'sharp'
import { DelayedError, type Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { fetchWithTimeoutAndRetry } from '@/lib/ark-api'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { executeAiVisionStep } from '@/lib/ai-runtime'
import { getUserModelConfig } from '@/lib/config-service'
import {
  CHARACTER_IMAGE_BANANA_RATIO,
  getArtStylePrompt,
} from '@/lib/constants'
import { buildCharacterAssetPrompt } from '@/lib/character-asset-prompt'
import { encodeImageUrls } from '@/lib/contracts/image-urls-contract'
import { generateUniqueKey, getSignedUrl, uploadObject } from '@/lib/storage'
import { initializeFonts, createLabelSVG } from '@/lib/fonts'
import { reportTaskProgress } from '@/lib/workers/shared'
import { assertTaskActive, resolveImageSourceFromGeneration } from '@/lib/workers/utils'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { normalizeImageGenerationCount } from '@/lib/image-generation/count'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import {
  parseReferenceImages,
  readBoolean,
  readString,
} from './reference-to-character-helpers'
async function generateReferenceImage(params: {
  job: Job<TaskJobData>
  imageIndex: number
  userId: string
  imageModel: string
  prompt: string
  referenceImages?: string[]
  comfyReferenceImages?: string[]
  keyPrefix: string
  labelText?: string
}): Promise<string | null> {
  const {
    job,
    imageIndex,
    userId,
    imageModel,
    prompt,
    referenceImages,
    comfyReferenceImages,
    keyPrefix,
    labelText,
  } = params

  try {
    await assertTaskActive(job, `reference_to_character_generate_${imageIndex + 1}`)
    const finalImageUrl = await resolveImageSourceFromGeneration(job, {
      userId,
      modelId: imageModel,
      comfyWorkflowVersionId: readString(job.data.payload?.comfyWorkflowVersionId) || undefined,
      invocationKey: `${job.data.taskId}:reference-character:${keyPrefix}:image:${imageIndex}`,
      prompt,
      comfyReferenceImages,
      options: { referenceImages, aspectRatio: CHARACTER_IMAGE_BANANA_RATIO },
    })

    const imgRes = await fetchWithTimeoutAndRetry(finalImageUrl, {
      logPrefix: `[reference-to-character:${imageIndex + 1}]`,
    })
    const buffer = Buffer.from(await imgRes.arrayBuffer())
    const processed = labelText
      ? await (async () => {
        const meta = await sharp(buffer).metadata()
        const width = meta.width || 2160
        const height = meta.height || 2160
        const fontSize = Math.floor(height * 0.04)
        const pad = Math.floor(fontSize * 0.5)
        const barHeight = fontSize + pad * 2
        const svg = await createLabelSVG(width, barHeight, fontSize, pad, labelText)
        return await sharp(buffer)
          .extend({
            top: barHeight,
            bottom: 0,
            left: 0,
            right: 0,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
          })
          .composite([{ input: svg, top: 0, left: 0 }])
          .jpeg({ quality: 90, mozjpeg: true })
          .toBuffer()
      })()
      : await sharp(buffer)
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer()

    const key = generateUniqueKey(`${keyPrefix}-${Date.now()}-${imageIndex}`, 'jpg')
    return await uploadObject(processed, key)
  } catch (error) {
    if (error instanceof DelayedError || (error instanceof Error && error.name === 'DelayedError')) {
      throw error
    }
    return null
  }
}

export async function handleReferenceToCharacterTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as Record<string, unknown>
  const allReferenceImages = parseReferenceImages(payload)
  if (allReferenceImages.length === 0) {
    throw new Error('Missing referenceImageUrl or referenceImageUrls')
  }

  const isAssetHub = job.data.type === TASK_TYPE.ASSET_HUB_REFERENCE_TO_CHARACTER
  const isProject = job.data.type === TASK_TYPE.REFERENCE_TO_CHARACTER
  if (!isAssetHub && !isProject) {
    throw new Error(`Unsupported task type: ${job.data.type}`)
  }

  const isBackgroundJob = readBoolean(payload.isBackgroundJob)
  const appearanceId = readString(payload.appearanceId)
  const characterId = readString(payload.characterId)
  const extractOnly = readBoolean(payload.extractOnly)
  const customDescription = readString(payload.customDescription)
  const characterName = readString(payload.characterName) || '新角色 - 初始形象'
  const artStyle = readString(payload.artStyle)

  if (isBackgroundJob && (!characterId || !appearanceId)) {
    throw new Error('Missing characterId or appearanceId for background job')
  }

  await reportTaskProgress(job, 15, {
    stage: 'reference_to_character_prepare',
    stageLabel: '准备参考图转换参数',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'reference_to_character_prepare')
  if (isProject) {
    await initializeFonts()
  }

  const userConfig = await getUserModelConfig(job.data.userId)
  const imageModel = readString(payload.imageModel) || readString(userConfig.characterModel)
  const analysisModel = readString(userConfig.analysisModel)
  if (!imageModel && !extractOnly) {
    throw new Error('请先在设置页面配置角色图片模型')
  }
  if (!analysisModel && extractOnly) {
    throw new Error('请先在设置页面配置分析模型')
  }

  if (extractOnly) {
    await reportTaskProgress(job, 45, {
      stage: 'reference_to_character_extract',
      stageLabel: '提取参考图描述',
      displayMode: 'detail',
    })
    const completion = await executeAiVisionStep({
      userId: job.data.userId,
      model: analysisModel,
      prompt: buildPrompt({
        promptId: PROMPT_IDS.CHARACTER_IMAGE_TO_DESCRIPTION,
        locale: job.data.locale,
      }),
      imageUrls: allReferenceImages,
      temperature: 0.3,
      ...(isProject ? { projectId: job.data.projectId } : {}),
    })
    await assertTaskActive(job, 'reference_to_character_extract_done')
    await reportTaskProgress(job, 96, {
      stage: 'reference_to_character_extract_done',
      stageLabel: '参考图描述提取完成',
      displayMode: 'detail',
    })
    return {
      success: true,
      description: completion.text,
    }
  }

  const artStylePrompt = getArtStylePrompt(artStyle, job.data.locale)

  const basePrompt = customDescription || buildPrompt({
    promptId: PROMPT_IDS.CHARACTER_REFERENCE_TO_SHEET,
    locale: job.data.locale,
  })
  const prompt = buildCharacterAssetPrompt(basePrompt, artStylePrompt)

  const useReferenceImages = !customDescription
  const normalizedReferenceImages = useReferenceImages
    ? await normalizeReferenceImagesForGeneration(allReferenceImages)
    : undefined
  const isComfyImageModel = parseModelKeyStrict(imageModel)?.provider === 'comfyui'
  const keyPrefix = isAssetHub ? 'ref-char' : `proj-ref-char-${job.data.projectId}`
  const count = normalizeImageGenerationCount('reference-to-character', payload.count)

  await reportTaskProgress(job, 35, {
    stage: 'reference_to_character_generate',
    stageLabel: '生成角色三视图',
    displayMode: 'detail',
  })

  const generateAtIndex = async (index: number) => await generateReferenceImage({
    job,
    imageIndex: index,
    userId: job.data.userId,
    imageModel,
    prompt,
    referenceImages: normalizedReferenceImages,
    comfyReferenceImages: useReferenceImages ? allReferenceImages : undefined,
    keyPrefix,
    ...(isProject ? { labelText: characterName } : {}),
  })
  const indexes = Array.from({ length: count }, (_value, index) => index)
  const imageResults: Array<string | null> = []
  if (isComfyImageModel) {
    for (const index of indexes) imageResults.push(await generateAtIndex(index))
  } else {
    imageResults.push(...await Promise.all(indexes.map(generateAtIndex)))
  }

  let description: string | null = null
  if (analysisModel) {
    const analysisPrompt = buildPrompt({
      promptId: PROMPT_IDS.CHARACTER_IMAGE_TO_DESCRIPTION,
      locale: job.data.locale,
    })
    const completion = await executeAiVisionStep({
      userId: job.data.userId,
      model: analysisModel,
      prompt: analysisPrompt,
      imageUrls: allReferenceImages,
      temperature: 0.3,
      ...(isProject ? { projectId: job.data.projectId } : {}),
    })
    description = completion.text
  }

  const successfulCosKeys = imageResults.filter((item): item is string => Boolean(item))
  if (successfulCosKeys.length === 0) {
    throw new Error('图片生成失败')
  }

  await assertTaskActive(job, 'reference_to_character_persist')
  if (isBackgroundJob && appearanceId) {
    const mainImageKey = successfulCosKeys[0]
    const mainImageMedia = await ensureMediaObjectFromStorageKey(mainImageKey)
    const descriptions = description
      ? JSON.stringify(successfulCosKeys.map(() => description))
      : undefined
    if (isAssetHub) {
      await prisma.globalCharacterAppearance.update({
        where: { id: appearanceId },
        data: {
          imageUrl: mainImageKey,
          imageUrls: encodeImageUrls(successfulCosKeys),
          imageMediaId: mainImageMedia.id,
          description: description || undefined,
          descriptions,
        },
      })
    } else {
      await prisma.characterAppearance.update({
        where: { id: appearanceId },
        data: {
          imageUrl: mainImageKey,
          imageUrls: encodeImageUrls(successfulCosKeys),
          imageMediaId: mainImageMedia.id,
          description: description || undefined,
          descriptions,
        },
      })
    }
    await reportTaskProgress(job, 96, {
      stage: 'reference_to_character_done',
      stageLabel: '参考图转换完成',
      displayMode: 'detail',
    })
    return { success: true }
  }

  const mainCosKey = successfulCosKeys[0]
  const mainSignedUrl = getSignedUrl(mainCosKey, 7 * 24 * 3600)

  await reportTaskProgress(job, 96, {
    stage: 'reference_to_character_done',
    stageLabel: '参考图转换完成',
    displayMode: 'detail',
  })

  return {
    success: true,
    imageUrl: mainSignedUrl,
    cosKey: mainCosKey,
    cosKeys: successfulCosKeys,
    description,
  }
}
