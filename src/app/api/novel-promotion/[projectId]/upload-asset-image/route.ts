import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import sharp from 'sharp'
import { initializeFonts, createLabelSVG } from '@/lib/fonts'
import { decodeImageUrlsFromDb, encodeImageUrls } from '@/lib/contracts/image-urls-contract'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { PRIMARY_APPEARANCE_INDEX } from '@/lib/constants'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

interface CharacterAppearanceRecord {
  id: string
  imageUrls: string | null
  selectedIndex: number | null
}

interface LocationImageRecord {
  id: string
  imageIndex: number
}

interface LocationRecord {
  selectedImageId: string | null
  images?: LocationImageRecord[]
}

interface UploadAssetImageDb {
  novelPromotionCharacter: {
    findFirst(args: Record<string, unknown>): Promise<{
      id: string
      name: string
      profileConfirmed: boolean
    } | null>
    update(args: Record<string, unknown>): Promise<unknown>
  }
  characterAppearance: {
    findFirst(args: Record<string, unknown>): Promise<CharacterAppearanceRecord | null>
    upsert(args: Record<string, unknown>): Promise<CharacterAppearanceRecord>
    update(args: Record<string, unknown>): Promise<unknown>
  }
  novelPromotionLocation: {
    findFirst(args: Record<string, unknown>): Promise<LocationRecord | null>
    update(args: Record<string, unknown>): Promise<unknown>
  }
  locationImage: {
    update(args: Record<string, unknown>): Promise<{ id: string }>
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
}

/**
 * POST /api/novel-promotion/[projectId]/upload-asset-image
 * 上传用户自定义图片作为角色或场景资产
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params
  const db = prisma as unknown as UploadAssetImageDb

  // 初始化字体（在 Vercel 环境中需要）
  await initializeFonts()

  // 🔐 统一权限验证
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  // 解析表单数据
  const formData = await request.formData()
  const file = formData.get('file') as File
  const type = formData.get('type') as string // 'character' | 'location'
  const id = formData.get('id') as string // characterId 或 locationId
  const appearanceId = formData.get('appearanceId') as string | null  // UUID
  const imageIndex = formData.get('imageIndex') as string | null
  const labelText = formData.get('labelText') as string // 文字标识符

  if (!file || !id || !labelText || (type !== 'character' && type !== 'location')) {
    throw new ApiError('INVALID_PARAMS')
  }

  let character: Awaited<ReturnType<UploadAssetImageDb['novelPromotionCharacter']['findFirst']>> = null
  let targetAppearance: CharacterAppearanceRecord | null = null
  let location: LocationRecord | null = null
  const confirmsPendingProfile = type === 'character' && !appearanceId
  if (type === 'character') {
    character = await db.novelPromotionCharacter.findFirst({
      where: { id, novelPromotionProject: { projectId } },
      select: { id: true, name: true, profileConfirmed: true },
    })
    if (!character) throw new ApiError('NOT_FOUND')

    targetAppearance = appearanceId
      ? await db.characterAppearance.findFirst({
        where: {
          id: appearanceId,
          characterId: id,
          character: { novelPromotionProject: { projectId } },
        },
      })
      : await db.characterAppearance.upsert({
        where: {
          characterId_appearanceIndex: {
            characterId: id,
            appearanceIndex: PRIMARY_APPEARANCE_INDEX,
          },
        },
        update: {},
        create: {
          characterId: id,
          appearanceIndex: PRIMARY_APPEARANCE_INDEX,
          changeReason: '初始形象',
          description: labelText.trim(),
          descriptions: JSON.stringify([labelText.trim()]),
          imageUrls: encodeImageUrls([]),
          previousImageUrls: encodeImageUrls([]),
        },
      })
    if (!targetAppearance) throw new ApiError('NOT_FOUND')
  } else {
    location = await db.novelPromotionLocation.findFirst({
      where: { id, novelPromotionProject: { projectId } },
      include: { images: { orderBy: { imageIndex: 'asc' } } },
    })
    if (!location) throw new ApiError('NOT_FOUND')
  }

  // 读取文件
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // 添加文字标识符
  const meta = await sharp(buffer).metadata()
  const w = meta.width || 2160
  const h = meta.height || 2160
  const fontSize = Math.floor(h * 0.04)
  const pad = Math.floor(fontSize * 0.5)
  const barH = fontSize + pad * 2

  // 创建SVG文字条
  const svg = await createLabelSVG(w, barH, fontSize, pad, labelText)

  // 添加文字条到图片顶部
  const processed = await sharp(buffer)
    .extend({ top: barH, bottom: 0, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  // 生成唯一key并上传
  const keyPrefix = type === 'character'
    ? `char-${id}-${targetAppearance?.id}-upload`
    : `loc-${id}-upload`
  const key = generateUniqueKey(keyPrefix, 'jpg')
  await uploadObject(processed, key)
  const imageMedia = await ensureMediaObjectFromStorageKey(key, { mimeType: 'image/jpeg' })

  // 更新数据库
  if (type === 'character' && targetAppearance) {
    const appearance = targetAppearance

    // 解析现有图片数组
    const imageUrls = decodeImageUrlsFromDb(appearance.imageUrls, 'characterAppearance.imageUrls')

    // 如果指定了imageIndex，替换对应位置的图片
    const targetIndex = imageIndex !== null ? parseInt(imageIndex) : imageUrls.length

    // 确保数组足够大
    while (imageUrls.length <= targetIndex) {
      imageUrls.push('')
    }

    imageUrls[targetIndex] = key

    // 计算是否需要同步更新 imageUrl
    // 当上传的图片是选中的图片时，或者是第一张图片且没有选中任何图片时
    const selectedIndex = appearance.selectedIndex
    const shouldUpdateImageUrl =
      selectedIndex === targetIndex ||  // 上传的是选中的图片
      (selectedIndex === null && targetIndex === 0) ||  // 没有选中任何图片，上传的是第一张
      imageUrls.filter(u => !!u).length === 1  // 只有一张有效图片

    const updateData: Record<string, unknown> = {
      imageUrls: encodeImageUrls(imageUrls)
    }

    if (shouldUpdateImageUrl) {
      updateData.imageUrl = key
      updateData.imageMediaId = imageMedia.id
    }

    // 更新数据库
    await db.characterAppearance.update({
      where: { id: appearance.id },
      data: updateData
    })

    if (confirmsPendingProfile && character && !character.profileConfirmed) {
      await db.novelPromotionCharacter.update({
        where: { id: character.id },
        data: { profileConfirmed: true },
      })
    }

    return NextResponse.json({
      success: true,
      appearanceId: appearance.id,
      imageKey: key,
      imageIndex: targetIndex
    })

  } else if (type === 'location' && location) {
    // 如果指定了imageIndex，更新对应的图片记录
    if (imageIndex !== null) {
      const targetImageIndex = parseInt(imageIndex)
      const existingImage = location.images?.find((img) => img.imageIndex === targetImageIndex)

      if (existingImage) {
        const updated = await db.locationImage.update({
          where: { id: existingImage.id },
          data: { imageUrl: key, imageMediaId: imageMedia.id }
        })
        if (!location.selectedImageId) {
          await prisma.novelPromotionLocation.update({
            where: { id },
            data: { selectedImageId: updated.id }
          })
        }
      } else {
        const created = await db.locationImage.create({
          data: {
            locationId: id,
            imageIndex: targetImageIndex,
            imageUrl: key,
            imageMediaId: imageMedia.id,
            description: labelText,
            isSelected: targetImageIndex === 0
          }
        })
        if (!location.selectedImageId) {
          await prisma.novelPromotionLocation.update({
            where: { id },
            data: { selectedImageId: created.id }
          })
        }
      }

      return NextResponse.json({
        success: true,
        imageKey: key,
        imageIndex: targetImageIndex
      })
    } else {
      // 创建新的图片记录
      const maxIndex = location.images?.length || 0
      const created = await db.locationImage.create({
        data: {
          locationId: id,
          imageIndex: maxIndex,
          imageUrl: key,
          imageMediaId: imageMedia.id,
          description: labelText,
          isSelected: maxIndex === 0
        }
      })
      if (!location.selectedImageId) {
        await prisma.novelPromotionLocation.update({
          where: { id },
          data: { selectedImageId: created.id }
        })
      }

      return NextResponse.json({
        success: true,
        imageKey: key,
        imageIndex: maxIndex
      })
    }
  }

  throw new ApiError('INVALID_PARAMS')
})
