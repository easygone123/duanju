'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

export default function ViralReplicationUploadField(props: {
  file: File | null
  disabled?: boolean
  onFileChange: (file: File | null) => void
}) {
  const t = useTranslations('home.viralReplication')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <div>
      <label id="viral-video-label" className="mb-2 block text-sm font-medium text-[var(--glass-text-secondary)]">
        {t('videoLabel')}
      </label>
      <div
        className={`rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? 'border-blue-500 bg-blue-500/10' : 'border-[var(--glass-stroke-strong)]'
        }`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          props.onFileChange(event.dataTransfer.files[0] || null)
        }}
      >
        <input
          ref={inputRef}
          id="viral-video-input"
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov"
          disabled={props.disabled}
          aria-labelledby="viral-video-label"
          className="sr-only"
          onChange={(event) => props.onFileChange(event.target.files?.[0] || null)}
        />
        <button
          type="button"
          disabled={props.disabled}
          onClick={() => inputRef.current?.click()}
          className="glass-btn-base glass-btn-secondary px-4 py-2 text-sm"
        >
          {props.file ? props.file.name : t('chooseVideo')}
        </button>
        <p className="mt-2 text-xs text-[var(--glass-text-tertiary)]">{t('videoHint')}</p>
      </div>
    </div>
  )
}
