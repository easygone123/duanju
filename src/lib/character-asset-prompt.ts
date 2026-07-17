import { addCharacterPromptSuffix, removeCharacterPromptSuffix } from '@/lib/constants'

export function buildCharacterAssetPrompt(
  basePrompt: string,
  artStylePrompt?: string | null,
): string {
  const base = removeCharacterPromptSuffix(basePrompt).replace(/，+$/, '').trim()
  const style = (artStylePrompt || '').trim()
  return addCharacterPromptSuffix([base, style].filter(Boolean).join('，'))
}
