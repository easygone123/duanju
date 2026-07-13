import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('image worker snapshot integration contract', () => {
  it.each([
    ['src/lib/workers/handlers/panel-image-task-handler.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/panel-variant-task-handler.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/image-task-handlers-core.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/asset-hub-modify-task-handler.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/reference-to-character.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/image-task-handler-shared.ts', 'resolveImageSourceFromGeneration'],
    ['src/lib/workers/handlers/character-image-task-handler.ts', 'generateProjectLabeledImageToStorage'],
    ['src/lib/workers/handlers/location-image-task-handler.ts', 'generateProjectLabeledImageToStorage'],
  ])('%s funnels generation through the snapshot-enforcing utility', (path, expectedCall) => {
    expect(readFileSync(path, 'utf8')).toContain(expectedCall)
  })

  it('resolves queued image snapshots in both central image generation utilities', () => {
    const source = readFileSync('src/lib/workers/utils.ts', 'utf8')
    expect(source).toContain('resolveImageGenerationSnapshot(job, params)')
    expect(source.match(/resolveImageGenerationSnapshot\(job, params\)/g)).toHaveLength(2)
    expect(source).toContain('modelKey: snapshot.model')
    expect(source).toContain('workflowVersionId: snapshot.comfyWorkflowVersionId')
  })

  it('resolves queued video snapshots in the central video generation utility', () => {
    const source = readFileSync('src/lib/workers/utils.ts', 'utf8')
    expect(source).toContain('resolveVideoGenerationSnapshot(job, params)')
    expect(source).toContain('modelKey: snapshot.model')
  })

  it('does not let reference-to-character bypass central image snapshot resolution', () => {
    const source = readFileSync('src/lib/workers/handlers/reference-to-character.ts', 'utf8')
    expect(source).not.toContain("from '@/lib/generator-api'")
    expect(source).not.toContain('generateImage(')
    expect(source).toContain('resolveImageSourceFromGeneration(job, {')
  })

  it('preserves payload snapshot fields through task normalization and BullMQ serialization', () => {
    const submitter = readFileSync('src/lib/task/submitter.ts', 'utf8')
    const queues = readFileSync('src/lib/task/queues.ts', 'utf8')
    expect(submitter).toMatch(/const nextPayload = \{\s*\.\.\.\(payload \|\| \{\}\),?\s*\}/)
    expect(queues).toContain('return await queue.add(data.type, data, {')
  })

  it.each([
    ['src/lib/config-service.ts', 'comfyModelSnapshotVersion: 1'],
    ['src/lib/novel-promotion/video/server-panel-video-submission.ts', 'payload.comfyModelSnapshotVersion = 1'],
    ['src/app/api/novel-promotion/[projectId]/reference-to-character/route.ts', 'body.comfyModelSnapshotVersion = 1'],
  ])('%s writes the trusted snapshot marker after sanitizing input', (path, marker) => {
    expect(readFileSync(path, 'utf8')).toContain(marker)
  })
})
