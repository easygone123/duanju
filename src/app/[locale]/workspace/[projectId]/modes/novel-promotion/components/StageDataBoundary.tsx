'use client'

import type { ReactNode } from 'react'

interface StageDataBoundaryProps {
  data: unknown
  status: 'pending' | 'error' | 'success'
  error: unknown
  refetch: () => Promise<unknown>
  children: ReactNode
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Workspace stage data failed to load.'
}

export default function StageDataBoundary({
  data,
  status,
  error,
  refetch,
  children,
}: StageDataBoundaryProps) {
  if (data !== undefined) return children

  if (status === 'error') {
    return (
      <div className="min-h-[50vh] flex flex-col items-center justify-center gap-3" role="alert">
        <p>{errorMessage(error)}</p>
        <button
          type="button"
          className="glass-btn-base glass-btn-secondary px-4 py-2"
          onClick={() => { void refetch() }}
          aria-label="Retry loading stage data"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div
      className="min-h-[50vh] flex items-center justify-center text-[var(--glass-text-tertiary)]"
      role="status"
      aria-label="Loading workspace stage data"
      aria-busy="true"
    >
      Loading workspace stage data…
    </div>
  )
}
