import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { DeleteObjectsResult, SignedUrlParams, StorageProvider, UploadObjectParams, UploadObjectResult, UploadObjectStreamParams } from '@/lib/storage/types'
import { normalizeKey, toFetchableUrl } from '@/lib/storage/utils'

const UPLOAD_DIR = process.env.UPLOAD_DIR || './data/uploads'
const UPLOAD_ROOT = path.resolve(process.cwd(), UPLOAD_DIR)

function resolveUploadPath(key: string): string {
  const candidate = path.resolve(UPLOAD_ROOT, normalizeKey(key))
  const isContained = candidate === UPLOAD_ROOT || candidate.startsWith(`${UPLOAD_ROOT}${path.sep}`)
  if (!isContained) {
    throw new Error(`Storage key resolves outside upload directory: ${key}`)
  }
  return candidate
}

export class LocalStorageProvider implements StorageProvider {
  readonly kind = 'local' as const

  async uploadObject(params: UploadObjectParams): Promise<UploadObjectResult> {
    const normalizedKey = normalizeKey(params.key)
    const filePath = resolveUploadPath(normalizedKey)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, params.body)
    return { key: normalizedKey }
  }

  async uploadObjectStream(params: UploadObjectStreamParams): Promise<UploadObjectResult> {
    const normalizedKey = normalizeKey(params.key)
    const filePath = resolveUploadPath(normalizedKey)
    const tempPath = `${filePath}.part-${randomUUID()}`

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    try {
      await pipeline(params.body, createWriteStream(tempPath))
      await fs.rename(tempPath, filePath)
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }

    return { key: normalizedKey }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await fs.unlink(resolveUploadPath(key))
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code
      if (code !== 'ENOENT') {
        throw error
      }
    }
  }

  async deleteObjects(keys: string[]): Promise<DeleteObjectsResult> {
    const validKeys = keys.filter((key) => typeof key === 'string' && key.trim().length > 0)
    let success = 0
    let failed = 0

    for (const key of validKeys) {
      try {
        await this.deleteObject(key)
        success += 1
      } catch {
        failed += 1
      }
    }

    return { success, failed }
  }

  async getSignedObjectUrl(params: SignedUrlParams): Promise<string> {
    void params.expiresInSeconds
    const normalizedKey = normalizeKey(params.key)
    resolveUploadPath(normalizedKey)
    return `/api/files/${encodeURIComponent(normalizedKey)}`
  }

  async getInternalSignedObjectUrl(params: SignedUrlParams): Promise<string> {
    return await this.getSignedObjectUrl(params)
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    return await fs.readFile(resolveUploadPath(key))
  }

  async getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(resolveUploadPath(key))
  }

  extractStorageKey(input: string | null | undefined): string | null {
    if (!input) return null
    if (input.startsWith('/api/files/')) {
      return normalizeKey(decodeURIComponent(input.replace('/api/files/', '')))
    }
    if (!input.startsWith('http') && !input.startsWith('/')) {
      return normalizeKey(input)
    }

    try {
      const parsed = new URL(input)
      return normalizeKey(parsed.pathname)
    } catch {
      return null
    }
  }

  toFetchableUrl(inputUrl: string): string {
    return toFetchableUrl(inputUrl)
  }

  generateUniqueKey(params: { prefix: string; ext: string }): string {
    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2, 8)
    return `images/${params.prefix}-${timestamp}-${random}.${params.ext}`
  }
}
