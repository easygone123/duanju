import { describe, expect, it } from 'vitest'

import { getProjectOpenPath } from '@/lib/viral-replication/navigation'

describe('viral replication project navigation', () => {
  it.each(['uploading', 'analyzing', 'review_ready', 'generating', 'failed'])(
    're-enters the replication page while status is %s',
    (status) => {
      expect(getProjectOpenPath({
        id: 'project-1',
        viralReplication: { id: 'rep-1', status },
      })).toBe('/workspace/project-1/viral-replication/rep-1')
    },
  )

  it('opens the ordinary workspace after replication completes', () => {
    expect(getProjectOpenPath({
      id: 'project-1',
      viralReplication: { id: 'rep-1', status: 'completed' },
    })).toBe('/workspace/project-1')
  })

  it('leaves ordinary projects unchanged', () => {
    expect(getProjectOpenPath({ id: 'project-ordinary' })).toBe('/workspace/project-ordinary')
  })
})
