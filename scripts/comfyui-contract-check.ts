import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { checkComfyCompatibility } from '../src/lib/comfyui/compatibility'
import { ComfyClient } from '../src/lib/comfyui/client'
import { extractComfyOutputs } from '../src/lib/comfyui/workflow-output'
import { renderComfyWorkflow } from '../src/lib/comfyui/workflow-renderer'
import { deriveComfyRequirements } from '../src/lib/comfyui/workflow-requirements'
import { validateWorkflowContract } from '../src/lib/comfyui/workflow-schema'
import { readComfyRuntimeConfig } from '../src/lib/comfyui/runtime'
import type {
  ComfyApiWorkflow,
  ComfyConnectionAuth,
  ComfyInputBinding,
  ComfyOutputBinding,
  ComfyVariableDefinition,
  ComfyVariableValue,
} from '../src/lib/comfyui/types'

const MAX_CONTRACT_BYTES = 4 * 1024 * 1024

export interface ComfyContractCheckConfig {
  baseUrl: string
  workflowFile: string
  auth: ComfyConnectionAuth
  networkPolicy: ReturnType<typeof readComfyRuntimeConfig>['networkPolicy']
  timeoutMs: number
}

interface ContractBundle {
  graph: ComfyApiWorkflow
  variableDefinitions: ComfyVariableDefinition[]
  bindings: ComfyInputBinding[]
  outputs: ComfyOutputBinding[]
  variables: Record<string, ComfyVariableValue>
}

export function readComfyContractCheckConfig(
  env: Record<string, string | undefined>,
): ComfyContractCheckConfig {
  const baseUrl = required(env, 'COMFYUI_CONTRACT_URL')
  const workflowFile = required(env, 'COMFYUI_CONTRACT_WORKFLOW_FILE')
  const timeoutMs = optionalInteger(env.COMFYUI_CONTRACT_TIMEOUT_MS, 120_000, 1_000, 1_200_000)
  return {
    baseUrl,
    workflowFile,
    timeoutMs,
    auth: readAuth(env),
    networkPolicy: readComfyRuntimeConfig({ ...env, COMFYUI_ENABLED: 'true' }).networkPolicy,
  }
}

export async function runComfyContractCheck(
  config: ComfyContractCheckConfig,
  output: { write(line: string): void } = { write: (line) => process.stdout.write(`${line}\n`) },
) {
  const timings: Record<string, number> = {}
  const startedAt = Date.now()
  const bundle = await timed(timings, 'validateMs', () => readContractBundle(config.workflowFile))
  const client = new ComfyClient({
    baseUrl: config.baseUrl,
    auth: config.auth,
    networkPolicy: config.networkPolicy,
    timeoutMs: config.timeoutMs,
    maxWorkflowBytes: MAX_CONTRACT_BYTES,
    maxOutputBytes: 512 * 1024 * 1024,
  })
  await timed(timings, 'probeMs', () => client.getSystemStats())
  const workflowHash = createHash('sha256').update(JSON.stringify(bundle.graph)).digest('hex')
  const compatibility = await timed(timings, 'compatibilityMs', () => checkComfyCompatibility({
    connectionId: 'contract-check', workflowHash, graph: bundle.graph,
    requirements: deriveComfyRequirements(bundle.graph), client,
  }))
  if (!compatibility.compatible) throw new Error('ComfyUI contract workflow is incompatible')
  const renderedGraph = renderComfyWorkflow({
    graph: bundle.graph, variables: bundle.variables,
    variableDefinitions: bundle.variableDefinitions, bindings: bundle.bindings, uploads: {},
  })
  const submitted = await timed(timings, 'submitMs', () => client.submitPrompt(
    renderedGraph,
    `waoowaoo-contract-${createHash('sha256').update(`${Date.now()}:${workflowHash}`).digest('hex').slice(0, 16)}`,
  ))
  const history = await timed(timings, 'executeMs', () => waitForHistory(
    client, submitted.promptId, config.timeoutMs,
  ))
  const outputs = extractComfyOutputs(history, bundle.outputs)
  const primaryRef = outputs.find((candidate) => candidate.primary)
  if (!primaryRef) throw new Error('ComfyUI contract workflow has no primary output')
  const bytes = await timed(timings, 'fetchMs', () => client.downloadOutput(primaryRef))
  const primary = { mediaType: primaryRef.mediaType, byteSize: bytes.byteLength }
  output.write(JSON.stringify({
    ok: true, compatibility: 'compatible', primary,
    timings: { ...timings, totalMs: Date.now() - startedAt },
  }))
  return { primary, timings }
}

async function readContractBundle(filename: string): Promise<ContractBundle> {
  const bytes = await readFile(filename)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTRACT_BYTES) {
    throw new Error('ComfyUI contract workflow file has an invalid size')
  }
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('ComfyUI contract workflow file is not valid JSON')
  }
  if (!isRecord(raw)) throw new Error('ComfyUI contract workflow bundle is invalid')
  const contract = {
    graph: raw.graph,
    variableDefinitions: Array.isArray(raw.variableDefinitions) ? raw.variableDefinitions : [],
    bindings: Array.isArray(raw.bindings) ? raw.bindings : [],
    outputs: raw.outputs,
    variables: isRecord(raw.variables) ? raw.variables : {},
  }
  const issues = validateWorkflowContract(contract as never)
  if (issues.length > 0) throw new Error('ComfyUI contract workflow validation failed')
  return contract as ContractBundle
}

async function waitForHistory(client: ComfyClient, promptId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const history = await client.getHistory(promptId)
    if (Object.hasOwn(history, promptId) || Object.hasOwn(history, 'outputs')) return history
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))))
  }
  throw new Error('ComfyUI contract workflow timed out')
}

function readAuth(env: Record<string, string | undefined>): ComfyConnectionAuth {
  const type = env.COMFYUI_CONTRACT_AUTH_TYPE || 'none'
  if (type === 'none') return { type: 'none' }
  if (type === 'bearer') return { type, token: required(env, 'COMFYUI_CONTRACT_AUTH_TOKEN') }
  if (type === 'basic') return {
    type,
    username: required(env, 'COMFYUI_CONTRACT_AUTH_USERNAME'),
    password: required(env, 'COMFYUI_CONTRACT_AUTH_PASSWORD'),
  }
  throw new Error('COMFYUI_CONTRACT_AUTH_TYPE must be none, bearer, or basic')
}

function required(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

function optionalInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('COMFYUI_CONTRACT_TIMEOUT_MS is invalid')
  }
  return parsed
}

async function timed<T>(timings: Record<string, number>, key: string, operation: () => Promise<T>) {
  const startedAt = Date.now()
  try {
    return await operation()
  } finally {
    timings[key] = Date.now() - startedAt
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function main() {
  try {
    await runComfyContractCheck(readComfyContractCheckConfig(process.env))
  } catch {
    process.stderr.write('ComfyUI contract check failed; inspect server connectivity and sanitized configuration.\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
