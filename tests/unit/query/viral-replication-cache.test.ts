import { describe, expect, it } from 'vitest'

import { mergeViralReplicationDetail } from '@/lib/query/hooks/useViralReplication'
import type { ViralReplicationDetail } from '@/lib/viral-replication/client'

describe('viral replication query cache', () => {
  it('preserves project ownership and analysis data when generation returns a partial command result', () => {
    const previous = {
      id: 'rep-1',
      brief: '原创方向',
      videoRatio: '9:16',
      artStyle: 'realistic',
      status: 'review_ready' as const,
      reportJson: { schemaVersion: 1 },
      project: { id: 'project-1', name: '爆款复刻项目' },
      episode: { id: 'episode-1', episodeNumber: 1, name: '第 1 集' },
    }

    const merged = mergeViralReplicationDetail(previous, {
      id: 'rep-1',
      status: 'generating',
      taskId: 'task-generate-1',
    } as ViralReplicationDetail)

    expect(merged).toMatchObject({
      id: 'rep-1',
      status: 'generating',
      taskId: 'task-generate-1',
      project: { id: 'project-1' },
      episode: { id: 'episode-1' },
      reportJson: { schemaVersion: 1 },
      brief: '原创方向',
      videoRatio: '9:16',
      artStyle: 'realistic',
    })
  })
})
