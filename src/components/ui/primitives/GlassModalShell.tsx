'use client'

import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '@/components/ui/icons'

export interface GlassModalShellProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  footer?: ReactNode
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  closeOnBackdrop?: boolean
  closeOnEsc?: boolean
  showCloseButton?: boolean
  initialFocusRef?: RefObject<HTMLElement | null>
}

interface ModalStackEntry {
  id: symbol
  root: HTMLElement
}

interface IsolationSnapshot {
  ariaHidden: string | null
  inert: boolean
}

const modalStack: ModalStackEntry[] = []
const isolatedElements = new Map<HTMLElement, IsolationSnapshot>()
let previousBodyOverflow: string | null = null

function updatePageIsolation() {
  if (modalStack.length === 0) {
    for (const [element, snapshot] of isolatedElements) {
      if (snapshot.ariaHidden === null) element.removeAttribute('aria-hidden')
      else element.setAttribute('aria-hidden', snapshot.ariaHidden)
      element.toggleAttribute('inert', snapshot.inert)
    }
    isolatedElements.clear()
    if (previousBodyOverflow !== null) {
      document.body.style.overflow = previousBodyOverflow
      previousBodyOverflow = null
    }
    return
  }

  if (previousBodyOverflow === null) previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  const modalRoots = new Set(modalStack.map(({ root }) => root))
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || modalRoots.has(child)) continue
    if (!isolatedElements.has(child)) {
      isolatedElements.set(child, {
        ariaHidden: child.getAttribute('aria-hidden'),
        inert: child.hasAttribute('inert')
      })
    }
    child.setAttribute('aria-hidden', 'true')
    child.setAttribute('inert', '')
  }
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(','))).filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ')
}

export default function GlassModalShell({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  showCloseButton = true,
  initialFocusRef
}: GlassModalShellProps) {
  const entryIdRef = useRef(Symbol('glass-modal'))
  const rootRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const closeOnEscRef = useRef(closeOnEsc)
  const titleId = useId()
  const descriptionId = useId()
  onCloseRef.current = onClose
  closeOnEscRef.current = closeOnEsc

  useEffect(() => {
    if (!open || !rootRef.current || !surfaceRef.current) return
    const id = entryIdRef.current
    const entry = { id, root: rootRef.current }
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(entry)
    updatePageIsolation()

    const surface = surfaceRef.current
    const requestedTarget = initialFocusRef?.current
    const initialTarget = requestedTarget && surface.contains(requestedTarget)
      ? requestedTarget
      : getFocusableElements(surface)[0] ?? surface
    initialTarget.focus()

    const onKeydown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1]?.id !== id) return
      if (event.key === 'Escape' && closeOnEscRef.current) {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(surface)
      if (focusable.length === 0) {
        event.preventDefault()
        surface.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !surface.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !surface.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      const index = modalStack.findIndex((candidate) => candidate.id === id)
      if (index >= 0) modalStack.splice(index, 1)
      updatePageIsolation()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open, initialFocusRef])

  if (!open || typeof document === 'undefined') return null

  const maxWidthClass =
    size === 'sm' ? 'max-w-md' :
      size === 'lg' ? 'max-w-4xl' :
        size === 'xl' ? 'max-w-6xl' :
          'max-w-2xl'

  return createPortal(
    <div
      ref={rootRef}
      data-glass-modal-root
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget && modalStack[modalStack.length - 1]?.id === entryIdRef.current) onClose()
      }}
    >
      <div
        className="glass-overlay absolute inset-0"
        onMouseDown={() => {
          if (closeOnBackdrop && modalStack[modalStack.length - 1]?.id === entryIdRef.current) onClose()
        }}
      />
      <div
        ref={surfaceRef}
        data-glass-modal-surface
        tabIndex={-1}
        className={cx('glass-surface-modal relative z-10 flex max-h-[calc(100dvh-2rem)] min-h-0 w-full flex-col overflow-hidden', maxWidthClass)}
      >
        {(title || description || showCloseButton) && (
          <div className="flex flex-none items-start justify-between gap-4 px-5 py-4 sm:px-6">
            <div>
              {title ? <h2 id={titleId} className="text-lg font-semibold text-[var(--glass-text-primary)] sm:text-xl">{title}</h2> : null}
              {description ? <p id={descriptionId} className="mt-1 text-sm text-[var(--glass-text-secondary)]">{description}</p> : null}
            </div>
            {showCloseButton ? (
              <button
                type="button"
                onClick={onClose}
                className="glass-btn-base glass-btn-ghost h-9 w-9"
                aria-label="close"
              >
                <AppIcon name="close" className="h-5 w-5" />
              </button>
            ) : null}
          </div>
        )}

        <div className="glass-divider flex-none" />
        <div data-glass-modal-content className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6 sm:py-5">{children}</div>

        {footer ? (
          <>
            <div className="glass-divider flex-none" />
            <div className="flex-none px-5 py-4 sm:px-6">{footer}</div>
          </>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
