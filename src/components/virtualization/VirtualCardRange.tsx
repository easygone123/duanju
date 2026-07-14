'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react'

type RetentionRegistration = (token: symbol, active: boolean) => void
const VirtualCardRetentionContext = createContext<RetentionRegistration | null>(null)

export function useVirtualCardRetention(active: boolean): void {
  const register = useContext(VirtualCardRetentionContext)
  const tokenRef = useRef(Symbol('virtual-card-retention'))
  useEffect(() => {
    if (!register) return
    const token = tokenRef.current
    register(token, active)
    return () => register(token, false)
  }, [active, register])
}

function VirtualCardRetentionScope({
  cardKey,
  register,
  children,
}: {
  cardKey: string
  register: (key: string, token: symbol, active: boolean) => void
  children: ReactNode
}) {
  const registration = useCallback(
    (token: symbol, active: boolean) => register(cardKey, token, active),
    [cardKey, register],
  )
  return (
    <VirtualCardRetentionContext.Provider value={registration}>
      {children}
    </VirtualCardRetentionContext.Provider>
  )
}

export interface VirtualRange {
  /** Inclusive item index. */
  start: number
  /** Exclusive item index. */
  end: number
}

export interface ComputeVirtualRangeOptions {
  count: number
  scrollTop: number
  viewportHeight: number
  estimatedRowHeight: number
  overscan?: number
  columnCount?: number
  rowHeights?: readonly number[]
  rowGap?: number
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback
}

export function computeVirtualRange({
  count,
  scrollTop,
  viewportHeight,
  estimatedRowHeight,
  overscan = 1,
  columnCount = 1,
  rowHeights,
  rowGap = 0,
}: ComputeVirtualRangeOptions): VirtualRange {
  const safeCount = Math.max(0, Math.floor(count))
  if (safeCount === 0) return { start: 0, end: 0 }

  const columns = positiveInteger(columnCount, 1)
  const rowHeight = positiveInteger(estimatedRowHeight, 1)
  const rowCount = Math.ceil(safeCount / columns)
  const safeScrollTop = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0)
  const safeViewportHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0)
  const safeOverscan = Math.max(0, Math.floor(overscan))
  const safeRowGap = Math.max(0, Number.isFinite(rowGap) ? rowGap : 0)

  if (rowHeights?.length) {
    const offsets: number[] = []
    let offset = 0
    for (let row = 0; row < rowCount; row += 1) {
      offsets.push(offset)
      offset += positiveInteger(rowHeights[row] ?? rowHeight, rowHeight) + safeRowGap
    }

    let firstVisibleRow = rowCount - 1
    for (let row = 0; row < rowCount; row += 1) {
      const height = positiveInteger(rowHeights[row] ?? rowHeight, rowHeight)
      if (offsets[row] + height > safeScrollTop) {
        firstVisibleRow = row
        break
      }
    }

    const viewportBottom = safeScrollTop + safeViewportHeight
    let lastVisibleRowExclusive = firstVisibleRow + 1
    while (
      lastVisibleRowExclusive < rowCount
      && offsets[lastVisibleRowExclusive] < viewportBottom
    ) {
      lastVisibleRowExclusive += 1
    }
    const startRow = Math.max(0, firstVisibleRow - safeOverscan)
    const endRow = Math.min(rowCount, lastVisibleRowExclusive + safeOverscan)
    return {
      start: startRow * columns,
      end: Math.min(safeCount, endRow * columns),
    }
  }

  const firstVisibleRow = Math.min(rowCount - 1, Math.floor(safeScrollTop / rowHeight))
  const lastVisibleRowExclusive = Math.min(
    rowCount,
    Math.max(firstVisibleRow + 1, Math.ceil((safeScrollTop + safeViewportHeight) / rowHeight)),
  )
  const startRow = Math.max(0, firstVisibleRow - safeOverscan)
  const endRow = Math.min(rowCount, lastVisibleRowExclusive + safeOverscan)

  return {
    start: startRow * columns,
    end: Math.min(safeCount, endRow * columns),
  }
}

export function computeInitialVirtualRange(
  count: number,
  estimatedRowHeight: number,
  overscan: number,
): VirtualRange {
  return computeVirtualRange({
    count,
    scrollTop: 0,
    viewportHeight: estimatedRowHeight,
    estimatedRowHeight,
    overscan,
  })
}

function readGridColumnCount(element: HTMLElement): number {
  const template = window.getComputedStyle(element).gridTemplateColumns
  if (!template || template === 'none') return 1

  let depth = 0
  let columns = 1
  for (const character of template.trim()) {
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ' ' && depth === 0) columns += 1
  }
  return positiveInteger(columns, 1)
}

function readMeasuredRows(
  element: HTMLElement,
  columnCount: number,
  estimatedRowHeight: number,
): number[] {
  const rows: number[] = []
  const children = element.querySelectorAll<HTMLElement>(':scope > [data-virtual-card-index]')
  children.forEach((child, index) => {
    const row = Math.floor(index / columnCount)
    const measuredHeight = Math.ceil(child.getBoundingClientRect().height)
    rows[row] = Math.max(rows[row] ?? 0, measuredHeight > 0 ? measuredHeight : estimatedRowHeight)
  })
  return rows
}

interface UseMeasuredVirtualRangeOptions {
  count: number
  estimatedRowHeight: number
  overscan: number
}

function useMeasuredVirtualRange({
  count,
  estimatedRowHeight,
  overscan,
}: UseMeasuredVirtualRangeOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef({ columnCount: 1, rowHeights: [] as number[], rowGap: 0 })
  const [range, setRange] = useState<VirtualRange>(() => (
    computeInitialVirtualRange(count, estimatedRowHeight, overscan)
  ))

  const refreshLayoutMeasurements = useCallback(() => {
    const element = containerRef.current
    if (!element || typeof window === 'undefined') return
    const columnCount = readGridColumnCount(element)
    const computedStyle = window.getComputedStyle(element)
    const rowGap = Number.parseFloat(computedStyle.rowGap || computedStyle.gap || '0') || 0
    layoutRef.current = {
      columnCount,
      rowHeights: readMeasuredRows(element, columnCount, estimatedRowHeight),
      rowGap,
    }
  }, [estimatedRowHeight])

  const measure = useCallback(() => {
    const element = containerRef.current
    if (!element || typeof window === 'undefined') return

    const bounds = element.getBoundingClientRect()
    const layout = layoutRef.current
    const nextRange = computeVirtualRange({
      count,
      scrollTop: Math.max(0, -bounds.top),
      viewportHeight: window.innerHeight,
      estimatedRowHeight,
      overscan,
      columnCount: layout.columnCount,
      rowHeights: layout.rowHeights,
      rowGap: layout.rowGap,
    })
    setRange((current) => (
      current.start === nextRange.start && current.end === nextRange.end ? current : nextRange
    ))
  }, [count, estimatedRowHeight, overscan])

  useEffect(() => {
    let animationFrame: number | null = null
    const scheduleMeasure = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        measure()
      })
    }

    const scheduleLayoutMeasure = () => {
      refreshLayoutMeasurements()
      scheduleMeasure()
    }

    refreshLayoutMeasurements()
    measure()
    window.addEventListener('scroll', scheduleMeasure, { passive: true })
    window.addEventListener('resize', scheduleLayoutMeasure)

    const element = containerRef.current
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleLayoutMeasure)
    if (element) resizeObserver?.observe(element)

    const intersectionObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(scheduleMeasure, { rootMargin: '100% 0px' })
    if (element) intersectionObserver?.observe(element)

    return () => {
      window.removeEventListener('scroll', scheduleMeasure)
      window.removeEventListener('resize', scheduleLayoutMeasure)
      resizeObserver?.disconnect()
      intersectionObserver?.disconnect()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [measure, refreshLayoutMeasurements])

  return { containerRef, range }
}

export interface VirtualCardRangeProps<T> {
  items: readonly T[]
  getKey: (item: T, index: number) => string
  renderCard: (item: T, index: number) => ReactNode
  estimatedCardHeight: number
  estimatedRowHeight?: number
  overscan?: number
  pinnedIndices?: Iterable<number>
  className?: string
  cardClassName?: string | ((item: T, index: number, mounted: boolean) => string | undefined)
  cardStyle?: CSSProperties | ((item: T, index: number, mounted: boolean) => CSSProperties | undefined)
  /** Deterministic injection for tests and hosts with their own viewport calculation. */
  range?: VirtualRange
  onItemElement?: (item: T, index: number, element: HTMLDivElement | null) => void
  onMountedCountChange?: (count: number) => void
}

export function VirtualCardRange<T>({
  items,
  getKey,
  renderCard,
  estimatedCardHeight,
  estimatedRowHeight = estimatedCardHeight,
  overscan = 1,
  pinnedIndices,
  className,
  cardClassName,
  cardStyle,
  range: controlledRange,
  onItemElement,
  onMountedCountChange,
}: VirtualCardRangeProps<T>) {
  const measured = useMeasuredVirtualRange({
    count: items.length,
    estimatedRowHeight,
    overscan,
  })
  const range = controlledRange ?? measured.range
  const pinned = useMemo(() => new Set(pinnedIndices ?? []), [pinnedIndices])
  const [measuredHeights, setMeasuredHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [retentionTokens, setRetentionTokens] = useState<ReadonlyMap<string, ReadonlySet<symbol>>>(() => new Map())
  const registerRetention = useCallback((key: string, token: symbol, active: boolean) => {
    setRetentionTokens((current) => {
      const currentTokens = current.get(key) ?? new Set<symbol>()
      if (active === currentTokens.has(token)) return current
      const nextTokens = new Set(currentTokens)
      if (active) nextTokens.add(token)
      else nextTokens.delete(token)
      const next = new Map(current)
      if (nextTokens.size > 0) next.set(key, nextTokens)
      else next.delete(key)
      return next
    })
  }, [])
  const mountedCount = items.reduce((count, item, index) => (
    count + (
      index >= range.start && index < range.end
      || pinned.has(index)
      || focusedKey === getKey(item, index)
      || retentionTokens.has(getKey(item, index))
      ? 1
      : 0
    )
  ), 0)

  useEffect(() => {
    onMountedCountChange?.(mountedCount)
  }, [mountedCount, onMountedCountChange])

  useEffect(() => {
    const container = measured.containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      setMeasuredHeights((current) => {
        let next: Map<string, number> | null = null
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          if (element.dataset.virtualCardMounted !== 'true') continue
          const key = element.dataset.virtualCardKey
          const height = Math.ceil(entry.contentRect.height)
          if (!key || height <= 0 || current.get(key) === height) continue
          next ??= new Map(current)
          next.set(key, height)
        }
        return next ?? current
      })
    })

    for (const element of container.querySelectorAll<HTMLElement>('[data-virtual-card-index]')) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [items, measured.containerRef, mountedCount, range.end, range.start])

  return (
    <div ref={measured.containerRef} className={className}>
      {items.map((item, index) => {
        const key = getKey(item, index)
        const mounted = index >= range.start && index < range.end
          || pinned.has(index)
          || focusedKey === key
          || retentionTokens.has(key)
        const resolvedClassName = typeof cardClassName === 'function'
          ? cardClassName(item, index, mounted)
          : cardClassName
        const resolvedStyle = typeof cardStyle === 'function'
          ? cardStyle(item, index, mounted)
          : cardStyle
        const stableHeight = measuredHeights.get(key) ?? estimatedCardHeight
        const intrinsicStyle: CSSProperties = {
          minHeight: mounted ? undefined : `${stableHeight}px`,
          contentVisibility: 'auto',
          containIntrinsicSize: `${stableHeight}px`,
        }

        return (
          <div
            key={key}
            ref={(element) => onItemElement?.(item, index, element)}
            className={resolvedClassName}
            style={{ ...intrinsicStyle, ...resolvedStyle }}
            data-virtual-card-index={index}
            data-virtual-card-key={key}
            data-virtual-card-mounted={mounted ? 'true' : 'false'}
            onFocusCapture={() => setFocusedKey(key)}
            onBlurCapture={(event: FocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFocusedKey((current) => current === key ? null : current)
              }
            }}
          >
            {mounted ? (
              <VirtualCardRetentionScope cardKey={key} register={registerRetention}>
                <div data-testid="virtual-card-body">{renderCard(item, index)}</div>
              </VirtualCardRetentionScope>
            ) : (
              <div
                data-testid="virtual-card-spacer"
                data-virtual-card-key={key}
                data-virtual-card-spacer="true"
                style={{ minHeight: `${stableHeight}px` }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
