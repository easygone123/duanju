import { PROMPT_CATALOG } from './catalog'
import { PromptI18nError } from './errors'
import { getPromptTemplate } from './template-store'
import type { BuildPromptInput } from './types'

const SINGLE_PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g
const DOUBLE_PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}/g
const ANY_PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_]+)\}\}|\{([A-Za-z0-9_]+)\}/g

function extractPlaceholders(template: string): string[] {
  const keys = new Set<string>()

  for (const match of template.matchAll(SINGLE_PLACEHOLDER_PATTERN)) {
    const key = match[1]
    if (key) keys.add(key)
  }
  for (const match of template.matchAll(DOUBLE_PLACEHOLDER_PATTERN)) {
    const key = match[1]
    if (key) keys.add(key)
  }

  return Array.from(keys)
}

export function buildPrompt(input: BuildPromptInput): string {
  const { promptId, locale, variables = {} } = input
  const entry = PROMPT_CATALOG[promptId]
  if (!entry) {
    throw new PromptI18nError(
      'PROMPT_ID_UNREGISTERED',
      promptId,
      `Prompt is not registered: ${promptId}`,
    )
  }

  const template = getPromptTemplate(promptId, locale)

  const templatePlaceholders = extractPlaceholders(template)
  const defined = new Set(entry.variableKeys)

  for (const key of templatePlaceholders) {
    if (!defined.has(key)) {
      throw new PromptI18nError(
        'PROMPT_PLACEHOLDER_MISMATCH',
        promptId,
        `Template placeholder not declared in catalog: ${key}`,
        { key },
      )
    }
  }

  const providedKeys = Object.keys(variables)
  for (const key of providedKeys) {
    if (!defined.has(key)) {
      throw new PromptI18nError(
        'PROMPT_VARIABLE_UNEXPECTED',
        promptId,
        `Unexpected prompt variable: ${key}`,
        { key },
      )
    }
    if (typeof variables[key] !== 'string') {
      throw new PromptI18nError(
        'PROMPT_VARIABLE_VALUE_INVALID',
        promptId,
        `Prompt variable must be string: ${key}`,
        { key, type: typeof variables[key] },
      )
    }
  }

  for (const key of entry.variableKeys) {
    if (!(key in variables)) {
      throw new PromptI18nError(
        'PROMPT_VARIABLE_MISSING',
        promptId,
        `Missing prompt variable: ${key}`,
        { key },
      )
    }
  }

  return template.replace(ANY_PLACEHOLDER_PATTERN, (_token, doubleKey, singleKey) => {
    const key = (doubleKey || singleKey) as string
    return variables[key] || ''
  })
}
