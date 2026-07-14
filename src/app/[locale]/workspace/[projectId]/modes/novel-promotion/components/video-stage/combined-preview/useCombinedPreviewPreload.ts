'use client'

import { useEffect, useRef } from 'react'
import { prefetch } from 'remotion'
import type { CombinedPreviewItem } from '@/lib/novel-promotion/video/combined-preview'

type PrefetchHandle = ReturnType<typeof prefetch>

function release(handle: PrefetchHandle) {
  try {
    handle.free()
  } catch {
    // A stale or already-released Remotion handle must not interrupt navigation.
  }
}

export function useCombinedPreviewPreload(
  items: readonly CombinedPreviewItem[],
  activeIndex: number,
) {
  const handlesRef = useRef<Map<string, PrefetchHandle>>(new Map())

  useEffect(() => {
    const desiredUrls = new Set<string>()

    for (let index = activeIndex - 1; index <= activeIndex + 1; index += 1) {
      const videoUrl = items[index]?.videoUrl
      if (videoUrl) desiredUrls.add(videoUrl)
    }

    for (const videoUrl of desiredUrls) {
      if (handlesRef.current.has(videoUrl)) continue

      try {
        handlesRef.current.set(videoUrl, prefetch(videoUrl, { method: 'blob-url' }))
      } catch {
        // Prefetch is opportunistic; seeking must remain synchronous when it fails.
      }
    }

    for (const [videoUrl, handle] of handlesRef.current) {
      if (desiredUrls.has(videoUrl)) continue
      release(handle)
      handlesRef.current.delete(videoUrl)
    }
  }, [activeIndex, items])

  useEffect(() => () => {
    for (const handle of handlesRef.current.values()) release(handle)
    handlesRef.current.clear()
  }, [])
}
