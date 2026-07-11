import { z } from 'zod'

export const workflowContractSchema = z.object({
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

export const testWorkflowSchema = z.object({
  versionId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128),
  variables: z.record(z.string(), z.unknown()).default({}),
}).strict()
