'use client'

import { useTranslations } from 'next-intl'

import type { ViralAnalysisReportV1 } from '@/lib/viral-replication/contracts'

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = milliseconds / 1_000
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`
}

function FingerprintList({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded-xl border border-[var(--glass-stroke-base)] p-4">
      <h3 className="mb-2 text-sm font-semibold text-[var(--glass-text-primary)]">{title}</h3>
      <ul className="space-y-1 text-sm text-[var(--glass-text-secondary)]">
        {values.map((value) => <li key={value}>• <span>{value}</span></li>)}
      </ul>
    </div>
  )
}

export default function ViralAnalysisReport({
  report,
  transcriptText,
}: {
  report: ViralAnalysisReportV1
  transcriptText?: string | null
}) {
  const t = useTranslations('viralReplication')
  const overviewEntries = [
    ['report.hook', report.overview.hook],
    ['report.coreAppeal', report.overview.coreAppeal],
    ['report.pacing', report.overview.pacing],
    ['report.emotionalArc', report.overview.emotionalArc],
  ] as const

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--glass-text-primary)]">{t('report.overview')}</h2>
        <dl className="grid gap-4 md:grid-cols-2">
          {overviewEntries.map(([label, value]) => (
            <div key={label} className="rounded-xl bg-[var(--glass-bg-muted)] p-4">
              <dt className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--glass-text-tertiary)]">{t(label)}</dt>
              <dd className="text-sm leading-6 text-[var(--glass-text-primary)]">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {report.sourceStory ? (
        <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
          <h2 className="mb-4 text-lg font-semibold text-[var(--glass-text-primary)]">{t('report.sourceStory')}</h2>
          <dl className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl bg-[var(--glass-bg-muted)] p-4">
              <dt className="mb-1 text-xs text-[var(--glass-text-tertiary)]">{t('report.storySummary')}</dt>
              <dd className="text-sm leading-6 text-[var(--glass-text-primary)]">{report.sourceStory.summary}</dd>
            </div>
            <div className="rounded-xl bg-[var(--glass-bg-muted)] p-4">
              <dt className="mb-1 text-xs text-[var(--glass-text-tertiary)]">{t('report.premise')}</dt>
              <dd className="text-sm leading-6 text-[var(--glass-text-primary)]">{report.sourceStory.premise}</dd>
            </div>
          </dl>
          {report.sourceStory.characterRelations.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('report.characterRelations')}</h3>
              <ul className="mt-2 space-y-1 text-sm text-[var(--glass-text-secondary)]">
                {report.sourceStory.characterRelations.map((relation) => <li key={relation}>• <span>{relation}</span></li>)}
              </ul>
            </div>
          ) : null}
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-[var(--glass-text-primary)]">{t('report.storyBeats')}</h3>
            <ol className="mt-2 space-y-2 text-sm text-[var(--glass-text-secondary)]">
              {report.sourceStory.storyBeats.map((beat, index) => (
                <li key={`${beat.shotIndexes.join('-')}-${index}`} className="rounded-lg border border-[var(--glass-stroke-base)] p-3">
                  <span className="text-[var(--glass-text-tertiary)]">#{beat.shotIndexes.map((shotIndex) => shotIndex + 1).join(', #')} </span>
                  <span>{beat.beat}</span>
                  {beat.cause ? <span className="mt-1 block">← {beat.cause}</span> : null}
                  {beat.effect ? <span className="mt-1 block">→ {beat.effect}</span> : null}
                </li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--glass-text-primary)]">{t('report.styleFingerprint')}</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <FingerprintList title={t('report.composition')} values={report.styleFingerprint.composition} />
          <FingerprintList title={t('report.lighting')} values={report.styleFingerprint.lighting} />
          <FingerprintList title={t('report.color')} values={report.styleFingerprint.color} />
          <FingerprintList title={t('report.editing')} values={report.styleFingerprint.editing} />
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-[var(--glass-text-primary)]">{t('report.timeline')}</h2>
          <p className="mt-1 text-sm text-[var(--glass-text-tertiary)]">{t('audioSubtitleNotice')}</p>
        </div>
        {transcriptText?.trim() ? (
          <details className="mb-4 rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-4">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--glass-text-primary)]">
              {t('report.fullTranscript')}
            </summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-sm leading-6 text-[var(--glass-text-secondary)]">
              {transcriptText}
            </pre>
          </details>
        ) : null}
        <div className="space-y-4">
          {report.shots.map((shot) => (
            <article key={shot.shotIndex} className="rounded-xl border border-[var(--glass-stroke-base)] p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--glass-text-tertiary)]">
                <span className="rounded-full bg-[var(--glass-bg-muted)] px-2 py-1">#{shot.shotIndex + 1}</span>
                <span>{formatTimestamp(shot.startMs)}–{formatTimestamp(shot.endMs)}</span>
              </div>
              <dl className="grid gap-x-5 gap-y-3 text-sm md:grid-cols-2 lg:grid-cols-4">
                {([
                  ['report.shotType', shot.shotType],
                  ['report.cameraAngle', shot.cameraAngle],
                  ['report.cameraMove', shot.cameraMove],
                  ['report.composition', shot.composition],
                  ['report.actionBeat', shot.actionBeat],
                  ['report.transition', shot.transition],
                  ['report.subtitleSummary', shot.subtitleSummary || t('report.noSubtitle')],
                  ['report.narrativeFunction', shot.narrativeFunction],
                  ['report.visibleCharacters', shot.visibleCharacters.join('、') || '—'],
                  ['report.speaker', shot.speaker || '—'],
                  ['report.location', shot.location || '—'],
                  ['report.props', shot.props.join('、') || '—'],
                  ['report.dialogueIntent', shot.dialogueIntent || '—'],
                  ['report.plotBeat', shot.plotBeat || '—'],
                  ['report.causalLink', shot.causalLink || '—'],
                  ['report.analysisConfidence', `${Math.round(shot.analysisConfidence * 100)}%`],
                ] as const).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-[var(--glass-text-tertiary)]">{t(label)}</dt>
                    <dd className="mt-1 text-[var(--glass-text-primary)]">{value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </section>

      {report.originalAdaptationAdvice.length > 0 ? (
        <section className="rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-6">
          <h2 className="mb-3 text-lg font-semibold text-[var(--glass-text-primary)]">{t('report.advice')}</h2>
          <ul className="space-y-2 text-sm leading-6 text-[var(--glass-text-secondary)]">
            {report.originalAdaptationAdvice.map((advice) => <li key={advice}>• <span>{advice}</span></li>)}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
