import type { Readable } from 'node:stream'

export type StorageType = 'minio' | 'local' | 'cos'

export interface UploadObjectParams {
  key: string
  body: Buffer
  contentType?: string
}

export interface UploadObjectStreamParams {
  key: string
  body: Readable
  contentLength: number
  contentType?: string
}

export interface UploadObjectResult {
  key: string
}

export interface DeleteObjectsResult {
  success: number
  failed: number
}

export interface SignedUrlParams {
  key: string
  expiresInSeconds: number
}

export interface StorageProvider {
  readonly kind: StorageType
  uploadObject(params: UploadObjectParams): Promise<UploadObjectResult>
  uploadObjectStream(params: UploadObjectStreamParams): Promise<UploadObjectResult>
  deleteObject(key: string): Promise<void>
  deleteObjects(keys: string[]): Promise<DeleteObjectsResult>
  getSignedObjectUrl(params: SignedUrlParams): Promise<string>
  getInternalSignedObjectUrl(params: SignedUrlParams): Promise<string>
  getObjectBuffer(key: string): Promise<Buffer>
  getObjectStream(key: string): Promise<NodeJS.ReadableStream>
  extractStorageKey(input: string | null | undefined): string | null
  toFetchableUrl(inputUrl: string): string
  generateUniqueKey(params: { prefix: string; ext: string }): string
}

export interface StorageFactoryOptions {
  storageType?: string
}
