export type ProfileSection = 'billing' | 'apiConfig' | 'comfyui'

export function resolveProfileSection(value: string | null | undefined): ProfileSection {
  if (value === 'billing' || value === 'comfyui' || value === 'apiConfig') return value
  return 'apiConfig'
}
