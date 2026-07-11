import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ComfyUI project pin migration contract', () => {
  it('backfills only owner-matched published media workflows tested by an owned connection', () => {
    const sql = readFileSync(
      'prisma/migrations/20260712010000_pin_project_comfy_versions/migration.sql',
      'utf8',
    )
    const normalizedSql = sql.replace(/\s+/g, ' ')
    for (const required of [
      'project.`userId` = binding.`userId`',
      'image_workflow.`userId` = binding.`userId`',
      "image_workflow.`status` = 'published'",
      "image_workflow.`mediaType` = 'image'",
      'image_version.`publishedAt` IS NOT NULL',
      'image_connection.`userId` = binding.`userId`',
      'video_workflow.`userId` = binding.`userId`',
      "video_workflow.`status` = 'published'",
      "video_workflow.`mediaType` = 'video'",
      'video_version.`publishedAt` IS NOT NULL',
      'video_connection.`userId` = binding.`userId`',
      'CASE WHEN project.`id` IS NOT NULL AND image_connection.`id` IS NOT NULL',
      'CASE WHEN project.`id` IS NOT NULL AND video_connection.`id` IS NOT NULL',
    ]) {
      expect(normalizedSql).toContain(required)
    }
  })
})
