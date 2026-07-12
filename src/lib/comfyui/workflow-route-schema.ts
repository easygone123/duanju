import { z } from 'zod'
import { isBoundedLiveVariables } from './workflow-limits'

const uploadPayloadSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  contentType: z.enum([
    'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
  ]),
  base64: z.string().min(1).max(48 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict()

export const workflowContractSchema = z.object({
  purpose: z.enum(['generation', 'upscale']).optional(),
  apiFormatJson: z.union([z.string().max(4 * 1024 * 1024), z.record(z.string(), z.unknown())]),
  variableDefinitions: z.array(z.unknown()).max(256),
  bindings: z.array(z.unknown()).max(512),
  outputs: z.array(z.unknown()).max(128),
}).strict()

export const createWorkflowSchema = workflowContractSchema.extend({
  name: z.string().trim().min(1).max(160),
  mediaType: z.enum(['image', 'video']),
}).strict()

export const publishWorkflowSchema = z.object({
  versionId: z.string().trim().min(1).max(128),
}).strict()

export const updateWorkflowMetadataSchema = z.object({
  name: z.string().trim().min(1).max(160),
}).strict()

export const testWorkflowSchema = z.object({
  versionId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128),
  variables: z.record(z.string(), z.unknown()).refine(isBoundedLiveVariables).default({}),
  uploads: z.record(
    z.string(), z.union([uploadPayloadSchema, z.array(uploadPayloadSchema).min(1).max(8)]),
  ).refine((value) => Object.keys(value).length <= 16).default({}),
}).strict()
