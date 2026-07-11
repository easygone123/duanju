import { createProductionComfyRuntimeDeps } from '@/lib/comfyui/runtime-deps'
import {
  readComfyRuntimeConfig,
  startComfyRuntime,
  type ComfyRuntime,
  type ComfyRuntimeConfig,
} from '@/lib/comfyui/runtime'

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

export async function bootstrapWorkerProcesses<T extends ClosableWorker>(input: {
  env: Record<string, string | undefined>
  createWorkers(): Promise<T[]> | T[]
  startRuntime(config: ComfyRuntimeConfig): ComfyRuntime
}) {
  const config = readComfyRuntimeConfig(input.env)
  const workers = await input.createWorkers()
  const runtime = createWorkerComfyRuntimeManager(() => input.startRuntime(config)).start()
  return { config, workers, runtime }
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
