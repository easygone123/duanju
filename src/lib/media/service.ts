import path from 'node:path'
import { prisma } from '@/lib/prisma'
import { extractStorageKey } from '@/lib/storage'
import { stablePublicIdFromStorageKey } from './hash'
import type { MediaRef } from './types'

type MediaObjectRow = {
  id: string
  publicId: string
  storageKey: string
  sha256: string | null
  mimeType: string | null
  sizeBytes: bigint | number | null
  width: number | null
  height: number | null
  durationMs: number | null
  updatedAt: Date | string
}

type MediaModel = {
  findMany: (args: unknown) => Promise<unknown>
  findUnique: (args: unknown) => Promise<unknown>
  upsert: (args: unknown) => Promise<unknown>
}

const mediaModel = (prisma as unknown as { mediaObject: MediaModel }).mediaObject

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

function normalizeStorageKey(value: string): string {
  return value.replace(/^\/+/, '')
}

function isLikelyExternalUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

export function guessMimeTypeFromStorageKey(storageKey: string): string | null {
  const ext = path.extname(storageKey).toLowerCase()
  return MIME_BY_EXT[ext] || null
}

function mediaUrl(publicId: string): string {
  return `/m/${encodeURIComponent(publicId)}`
}

function extractPublicIdFromMediaRoute(value: string): string | null {
  if (!value.startsWith('/m/')) return null
  const routePart = value.split('?')[0]?.split('#')[0] || ''
  const encoded = routePart.replace('/m/', '').replace(/^\/+/, '')
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

function mapMediaObjectToRef(row: MediaObjectRow): MediaRef {
  return {
    id: row.id,
    publicId: row.publicId,
    url: mediaUrl(row.publicId),
    sha256: row.sha256,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    storageKey: row.storageKey,
  }
}

export interface MediaResolveCandidate {
  mediaId?: unknown
  legacyValue?: unknown
}

export interface ReadOnlyMediaResolver {
  resolve: (mediaId: unknown, legacyValue: unknown) => Promise<MediaRef | null>
  resolveLegacy: (legacyValue: unknown) => Promise<MediaRef | null>
}

function legacyStringValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const record = value as { url?: unknown; imageUrl?: unknown; key?: unknown }
  const nested = record.url ?? record.imageUrl ?? record.key
  return typeof nested === 'string' ? nested : null
}

/**
 * Resolve a read payload without migrating legacy values. All referenced media
 * objects are loaded in one query; unresolved legacy values remain fallbacks.
 */
export async function createReadOnlyMediaResolver(
  candidates: MediaResolveCandidate[],
): Promise<ReadOnlyMediaResolver> {
  const ids = new Set<string>()
  const publicIds = new Set<string>()
  const storageKeys = new Set<string>()

  for (const candidate of candidates) {
    if (typeof candidate.mediaId === 'string' && candidate.mediaId.trim()) {
      ids.add(candidate.mediaId)
    }
    const legacyValue = legacyStringValue(candidate.legacyValue)
    if (!legacyValue) continue
    const publicId = extractPublicIdFromMediaRoute(legacyValue)
    if (publicId) {
      publicIds.add(publicId)
      continue
    }
    const storageKey = extractStorageKeyFromLegacyValue(legacyValue)
    if (storageKey) storageKeys.add(normalizeStorageKey(storageKey))
  }

  const filters: Array<Record<string, unknown>> = []
  if (ids.size > 0) filters.push({ id: { in: [...ids] } })
  if (publicIds.size > 0) filters.push({ publicId: { in: [...publicIds] } })
  if (storageKeys.size > 0) filters.push({ storageKey: { in: [...storageKeys] } })

  const rows = filters.length === 0
    ? []
    : (await mediaModel.findMany({ where: { OR: filters } })) as MediaObjectRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const byPublicId = new Map(rows.map((row) => [row.publicId, row]))
  const byStorageKey = new Map(rows.map((row) => [normalizeStorageKey(row.storageKey), row]))

  const resolveLegacy = async (legacyValue: unknown): Promise<MediaRef | null> => {
    const value = legacyStringValue(legacyValue)
    if (!value) return null
    const publicId = extractPublicIdFromMediaRoute(value)
    if (publicId) {
      const row = byPublicId.get(publicId)
      return row ? mapMediaObjectToRef(row) : null
    }
    const storageKey = extractStorageKeyFromLegacyValue(value)
    if (!storageKey) return null
    const row = byStorageKey.get(normalizeStorageKey(storageKey))
    return row ? mapMediaObjectToRef(row) : null
  }

  return {
    resolve: async (mediaId: unknown, legacyValue: unknown) => {
      if (typeof mediaId === 'string' && mediaId.trim()) {
        const row = byId.get(mediaId)
        if (row) return mapMediaObjectToRef(row)
      }
      return resolveLegacy(legacyValue)
    },
    resolveLegacy,
  }
}

export async function ensureMediaObjectFromStorageKey(
  rawStorageKey: string,
  metadata?: Partial<Pick<MediaRef, 'mimeType' | 'sizeBytes' | 'width' | 'height' | 'durationMs'>>,
): Promise<MediaRef> {
  const storageKey = normalizeStorageKey(rawStorageKey)

  const existing = (await mediaModel.findUnique({ where: { storageKey } })) as MediaObjectRow | null
  if (existing != null) {
    return mapMediaObjectToRef(existing)
  }

  const publicId = stablePublicIdFromStorageKey(storageKey)
  try {
    const created = (await mediaModel.upsert({
      where: { publicId },
      update: {
        storageKey,
        mimeType: metadata?.mimeType ?? guessMimeTypeFromStorageKey(storageKey),
        sizeBytes: metadata?.sizeBytes == null ? undefined : BigInt(metadata.sizeBytes),
        width: metadata?.width ?? undefined,
        height: metadata?.height ?? undefined,
        durationMs: metadata?.durationMs ?? undefined,
      },
      create: {
        publicId,
        storageKey,
        mimeType: metadata?.mimeType ?? guessMimeTypeFromStorageKey(storageKey),
        sizeBytes: metadata?.sizeBytes == null ? null : BigInt(metadata.sizeBytes),
        width: metadata?.width ?? null,
        height: metadata?.height ?? null,
        durationMs: metadata?.durationMs ?? null,
      },
    })) as MediaObjectRow

    return mapMediaObjectToRef(created)
  } catch (error: unknown) {
    // P2002 = unique constraint violation. Another concurrent request already
    // created/updated the row.  Re-fetch instead of crashing.
    const code = (error as { code?: string })?.code
    if (code === 'P2002') {
      const fallback = (await mediaModel.findUnique({ where: { publicId } })) as MediaObjectRow | null
        ?? (await mediaModel.findUnique({ where: { storageKey } })) as MediaObjectRow | null
      if (fallback) return mapMediaObjectToRef(fallback)
    }
    throw error
  }
}

export async function getMediaObjectByPublicId(publicId: string) {
  const row = (await mediaModel.findUnique({ where: { publicId } })) as MediaObjectRow | null
  if (!row) return null
  return mapMediaObjectToRef(row)
}

export async function getMediaObjectById(id: string) {
  const row = (await mediaModel.findUnique({ where: { id } })) as MediaObjectRow | null
  if (!row) return null
  return mapMediaObjectToRef(row)
}

/**
 * 将任意媒体值（COS key / 签名URL / /m/publicId / 对象形态）归一化为 storageKey。
 * 这是服务端写路径（保存、比较、删除）应使用的唯一入口。
 */
export async function resolveStorageKeyFromMediaValue(value: unknown): Promise<string | null> {
  if (typeof value === 'string') {
    const publicId = extractPublicIdFromMediaRoute(value)
    if (publicId) {
      const media = await getMediaObjectByPublicId(publicId)
      return media?.storageKey || null
    }
    const key = extractStorageKey(value)
    return key ? normalizeStorageKey(key) : null
  }

  if (value && typeof value === 'object') {
    const maybeValue = (value as { url?: unknown; imageUrl?: unknown; key?: unknown }).url
      ?? (value as { imageUrl?: unknown }).imageUrl
      ?? (value as { key?: unknown }).key
    return resolveStorageKeyFromMediaValue(maybeValue)
  }

  return null
}

export function extractStorageKeyFromLegacyValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  if (value.startsWith('/m/')) return null

  // Keep external URLs that are actually COS object URLs (path -> key).
  if (isLikelyExternalUrl(value) || value.startsWith('/api/files/') || !value.startsWith('/')) {
    return extractStorageKey(value)
  }

  return null
}

export async function resolveMediaRefFromLegacyValue(value: unknown): Promise<MediaRef | null> {
  const storageKey = extractStorageKeyFromLegacyValue(value)
  if (!storageKey) return null
  return ensureMediaObjectFromStorageKey(storageKey)
}

export async function resolveMediaRef(
  mediaId: unknown,
  legacyValue: unknown,
): Promise<MediaRef | null> {
  if (typeof mediaId === 'string' && mediaId.trim()) {
    const mediaById = await getMediaObjectById(mediaId)
    if (mediaById) return mediaById
  }
  return resolveMediaRefFromLegacyValue(legacyValue)
}

export async function resolveMediaRefsFromLegacyJsonArray(jsonStr: unknown): Promise<MediaRef[]> {
  if (typeof jsonStr !== 'string' || !jsonStr.trim()) return []
  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) return []

    const refs = await Promise.all(
      parsed
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => resolveMediaRefFromLegacyValue(v)),
    )

    return refs.filter((v): v is MediaRef => !!v)
  } catch {
    return []
  }
}

export function mediaUrlFromRef(ref: MediaRef | null | undefined, fallback: string | null | undefined): string | null {
  if (ref?.url) return ref.url
  return fallback || null
}
