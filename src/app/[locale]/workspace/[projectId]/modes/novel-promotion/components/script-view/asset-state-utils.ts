import type { Character, CharacterAppearance, Location, Prop } from '@/types/project'
import { PRIMARY_APPEARANCE_INDEX } from '@/lib/constants'

interface ClipLike {
  characters: string | null
  location: string | null
  props?: string | null
}

type StoredCharacter = string | { name: string; appearance?: string }

export type ClipAssetSelectionCommit =
  | { type: 'character'; items: Array<{ characterId: string; appearanceName: string }> }
  | { type: 'location'; items: Array<{ locationId: string; label: string }> }
  | { type: 'prop'; propIds: string[] }

function normalizeAssetName(value: string): string {
  return value.trim().toLowerCase()
}

function parseStoredCharacters(raw: string | null): StoredCharacter[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is StoredCharacter => {
        if (typeof item === 'string') return !!item.trim()
        return !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
      })
    }
  } catch {
    // Fall back to the legacy comma-separated format.
  }
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function parseStoredNames(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    }
  } catch {
    // Fall back to the legacy comma-separated format.
  }
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const normalized = normalizeAssetName(name)
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

export function buildCharacterSelectionValue(input: {
  clip: ClipLike
  items: Array<{ characterId: string; appearanceName: string }>
  characters: Character[]
}): string {
  const managedNames = new Set(
    input.characters.flatMap((character) =>
      [character.name, ...character.name.split('/')]
        .map(normalizeAssetName)
        .filter(Boolean),
    ),
  )
  const unmanaged = parseStoredCharacters(input.clip.characters).filter((item) => {
    const name = typeof item === 'string' ? item : item.name
    return !managedNames.has(normalizeAssetName(name))
  })
  const charactersById = new Map(input.characters.map((character) => [character.id, character]))
  const seen = new Set<string>()
  const desired: Array<{ name: string; appearance: string }> = []

  input.items.forEach(({ characterId, appearanceName }) => {
    const character = charactersById.get(characterId)
    const label = appearanceName.trim()
    if (!character || !label) return
    const key = `${characterId}::${normalizeAssetName(label)}`
    if (seen.has(key)) return
    seen.add(key)
    desired.push({ name: character.name, appearance: label })
  })

  return JSON.stringify([...unmanaged, ...desired])
}

export function buildLocationSelectionValue(input: {
  clip: ClipLike
  items: Array<{ locationId: string; label: string }>
  locations: Location[]
  fuzzyMatchLocation: (left: string, right: string) => boolean
}): string {
  const unmanaged = parseStoredNames(input.clip.location).filter(
    (storedName) =>
      !input.locations.some((location) => input.fuzzyMatchLocation(storedName, location.name)),
  )
  const locationsById = new Map(input.locations.map((location) => [location.id, location]))
  const desired = input.items.flatMap(({ locationId, label }) => {
    const location = locationsById.get(locationId)
    if (!location) return []
    return [label.trim() || location.name]
  })

  return dedupeNames([...unmanaged, ...desired]).join(',')
}

export function buildPropSelectionValue(input: {
  clip: ClipLike
  propIds: string[]
  props: Prop[]
}): string | null {
  const managedNames = new Set(input.props.map((prop) => normalizeAssetName(prop.name)))
  const unmanaged = parseStoredNames(input.clip.props).filter(
    (storedName) => !managedNames.has(normalizeAssetName(storedName)),
  )
  const propsById = new Map(input.props.map((prop) => [prop.id, prop]))
  const desired = input.propIds.flatMap((propId) => {
    const prop = propsById.get(propId)
    return prop ? [prop.name] : []
  })
  const finalNames = dedupeNames([...unmanaged, ...desired])

  return finalNames.length > 0 ? JSON.stringify(finalNames) : null
}

export function getPrimaryAppearance(char: Character): CharacterAppearance | undefined {
  return char.appearances?.find((a) => a.appearanceIndex === PRIMARY_APPEARANCE_INDEX) || char.appearances?.[0]
}

export function getSelectedAppearances(
  char: Character,
  selectedAppearanceKeys: Set<string>,
): CharacterAppearance[] {
  const result: CharacterAppearance[] = []
  selectedAppearanceKeys.forEach((key) => {
    if (key.startsWith(`${char.id}::`)) {
      const appearanceName = key.split('::')[1]
      const matched = char.appearances?.find(
        (a) =>
          a.changeReason === appearanceName ||
          a.changeReason?.toLowerCase() === appearanceName.toLowerCase(),
      )
      if (matched) result.push(matched)
    }
  })

  if (result.length === 0) {
    const primary = getPrimaryAppearance(char)
    if (primary) result.push(primary)
  }
  return result
}

export function processCharacterInClip(params: {
  clip: ClipLike
  action: 'add' | 'remove'
  targetChar: Character
  appearanceName?: string
  characters: Character[]
  tAssets: (key: string) => string
}): string | null {
  const { clip, action, targetChar, appearanceName, characters, tAssets } = params
  let currentItems: Array<string | { name: string; appearance?: string }> = []
  try {
    currentItems = JSON.parse(clip.characters || '[]')
    if (!Array.isArray(currentItems)) throw new Error()
  } catch {
    currentItems = clip.characters
      ? clip.characters.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  }

  const aliases = targetChar.name.split('/').map((a) => a.trim()).filter(Boolean)
  const clipNameSet = new Set<string>()
  currentItems.forEach((item) => {
    if (typeof item === 'string') {
      if (item.trim()) clipNameSet.add(item.trim())
    } else if (item?.name) {
      const n = String(item.name).trim()
      if (n) clipNameSet.add(n)
    }
  })

  const removeNameSet = new Set<string>()
  if (clipNameSet.has(targetChar.name)) removeNameSet.add(targetChar.name)
  aliases.forEach((a) => {
    if (clipNameSet.has(a)) removeNameSet.add(a)
  })
  const nameMatches = (name: string) => removeNameSet.has(name) || name === targetChar.name
  const primaryLabel = tAssets('character.primary')

  const finalAppearanceName =
    appearanceName ||
    (targetChar.appearances?.find((appearance) => appearance.appearanceIndex === PRIMARY_APPEARANCE_INDEX)?.changeReason ||
      tAssets('character.primary'))
  const isPrimaryAppearance =
    !appearanceName || appearanceName === primaryLabel

  const hasSameAppearance = currentItems.some((item) => {
    if (typeof item === 'string') {
      return isPrimaryAppearance && nameMatches(item)
    }
    return nameMatches(item.name) && item.appearance === finalAppearanceName
  })

  const beforeLen = currentItems.length

  if (action === 'add') {
    if (!hasSameAppearance) {
      currentItems.push({ name: targetChar.name, appearance: finalAppearanceName })
    }
  } else {
    currentItems = currentItems.filter((item) => {
      if (typeof item === 'string') {
        return !nameMatches(item)
      }
      if (!nameMatches(item.name)) return true
      if (!item.appearance) return !isPrimaryAppearance
      if (item.appearance === finalAppearanceName) return false
      if (
        isPrimaryAppearance &&
        item.appearance === primaryLabel
      ) {
        return false
      }
      return true
    })

    if (currentItems.length === beforeLen) {
      const candidates = characters
        .map((c) => {
          const cAliases = [c.name, ...c.name.split('/').map((a) => a.trim()).filter(Boolean)]
          if (!cAliases.includes(targetChar.name)) return null
          const intersect = cAliases.filter((a) => clipNameSet.has(a))
          if (intersect.length === 0) return null
          return { intersect }
        })
        .filter(Boolean) as Array<{ intersect: string[] }>

      if (candidates.length === 1) {
        const fallbackRemoveSet = new Set(candidates[0].intersect)
        currentItems = currentItems.filter((item) => {
          if (typeof item === 'string') {
            return !fallbackRemoveSet.has(item)
          }
          if (!fallbackRemoveSet.has(item.name)) return true
          if (!item.appearance) return !isPrimaryAppearance
          if (item.appearance === finalAppearanceName) return false
          if (
            isPrimaryAppearance &&
            item.appearance === primaryLabel
          ) {
            return false
          }
          return true
        })
      }
    }
  }

  const newValue = JSON.stringify(currentItems)
  if (action === 'add' && hasSameAppearance) return null
  if (action === 'remove' && currentItems.length === beforeLen) return null
  return newValue
}

export function processLocationInClip(params: {
  clip: ClipLike
  action: 'add' | 'remove'
  targetLoc: Location
  locationName?: string
  fuzzyMatchLocation: (clipLocName: string, libraryLocName: string) => boolean
}): string | null {
  const { clip, action, targetLoc, locationName, fuzzyMatchLocation } = params
  let currentNames: string[] = []
  if (clip.location) {
    try {
      const parsed = JSON.parse(clip.location)
      if (Array.isArray(parsed)) {
        currentNames = parsed
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      } else {
        currentNames = clip.location.split(',').map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      currentNames = clip.location.split(',').map((s) => s.trim()).filter(Boolean)
    }
  }

  const beforeLen = currentNames.length
  let newLocationNames: string[] = []

  if (action === 'add') {
    const finalLocationName = locationName?.trim() || targetLoc.name
    if (!currentNames.some((n) => fuzzyMatchLocation(n, targetLoc.name))) {
      newLocationNames = [...currentNames, finalLocationName]
    } else {
      return null
    }
  } else {
    newLocationNames = currentNames.filter((n) => !fuzzyMatchLocation(n, targetLoc.name))
    if (newLocationNames.length === beforeLen) return null
  }

  return newLocationNames.join(',')
}

export function processPropInClip(params: {
  clip: ClipLike
  action: 'add' | 'remove'
  targetProp: Prop
}): string | null {
  const { clip, action, targetProp } = params
  let currentNames: string[] = []
  if (clip.props) {
    try {
      const parsed = JSON.parse(clip.props)
      currentNames = Array.isArray(parsed)
        ? parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
        : []
    } catch {
      currentNames = clip.props.split(',').map((item) => item.trim()).filter(Boolean)
    }
  }

  const beforeLen = currentNames.length
  if (action === 'add') {
    if (currentNames.some((name) => name.toLowerCase() === targetProp.name.toLowerCase())) {
      return null
    }
    return JSON.stringify([...currentNames, targetProp.name])
  }

  const nextNames = currentNames.filter((name) => name.toLowerCase() !== targetProp.name.toLowerCase())
  if (nextNames.length === beforeLen) return null
  return nextNames.length > 0 ? JSON.stringify(nextNames) : null
}
