export type ViralReplicationProjectListItem = {
  id: string
  viralReplication?: { id: string; status: string } | null
}

export function getProjectOpenPath(project: ViralReplicationProjectListItem): string {
  const replication = project.viralReplication
  if (replication && replication.status !== 'completed') {
    return `/workspace/${project.id}/viral-replication/${replication.id}`
  }
  return `/workspace/${project.id}`
}
