import { createProductionComfyRuntimeDeps } from '@/lib/comfyui/runtime-deps'
import { startComfyRuntime, type ComfyRuntime } from '@/lib/comfyui/runtime'

interface ClosableWorker {
  close(): Promise<unknown>
}

export function createWorkerComfyRuntimeManager(
  start: () => ComfyRuntime = () => startComfyRuntime({
    deps: createProductionComfyRuntimeDeps(),
  }),
) {
  let runtime: ComfyRuntime | null = null
  return {
    start() {
      runtime ??= start()
      return runtime
    },
  }
}

export async function closeWorkerProcesses(
  runtime: ComfyRuntime,
  workers: ClosableWorker[],
  closeRedis: () => Promise<unknown>,
) {
  await runtime.close()
  await Promise.all(workers.map((worker) => worker.close()))
  await closeRedis()
}
