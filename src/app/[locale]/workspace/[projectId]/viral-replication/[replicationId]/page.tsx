import ViralReplicationPage from '@/components/viral-replication/ViralReplicationPage'

export default async function ViralReplicationRoute({
  params,
}: {
  params: Promise<{ projectId: string; replicationId: string }>
}) {
  const { projectId, replicationId } = await params
  return <ViralReplicationPage projectId={projectId} replicationId={replicationId} />
}
