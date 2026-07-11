'use client'

import { useTranslations } from 'next-intl'
import type { WorkflowValidationIssue } from '@/lib/comfyui/types'

export interface WorkflowCompatibilityView {
  connectionId: string
  connectionName: string
  state: 'compatible' | 'incompatible' | 'unknown' | 'offline' | 'auth_failed'
  missingNodes?: string[]
  missingModels?: Array<{ nodeId: string; field: string; value: string }>
}

interface Props { issues: WorkflowValidationIssue[]; compatibility: WorkflowCompatibilityView[] }

export default function WorkflowCompatibilityTable({ issues, compatibility }: Props) {
  const t = useTranslations('comfyui.workflows')
  return <section aria-labelledby="workflow-compatibility-heading" className="space-y-3">
    <h4 id="workflow-compatibility-heading" className="font-medium">{t('compatibility')}</h4>
    {issues.length > 0 && <ul role="alert" className="space-y-1 rounded-xl border border-[var(--glass-stroke-danger)] p-3 text-xs text-[var(--glass-danger)]">
      {issues.map((issue, index) => <li key={`${issue.code}-${index}`}><code>{issue.path ?? '$'}</code> · {issue.code}</li>)}
    </ul>}
    <div className="overflow-x-auto"><table className="w-full min-w-[32rem] text-left text-xs"><thead><tr>
      <th className="p-2">{t('instance')}</th><th className="p-2">{t('state')}</th><th className="p-2">{t('details')}</th>
    </tr></thead><tbody>{compatibility.map((item) => <tr key={item.connectionId} className="border-t border-[var(--glass-stroke-base)]">
      <td className="p-2">{item.connectionName}</td><td className="p-2">{t(`compatibilityStates.${item.state}`)}</td>
      <td className="p-2">{[...(item.missingNodes ?? []), ...(item.missingModels ?? []).map((model) => `${model.nodeId}.${model.field}: ${model.value}`)].join(', ') || '—'}</td>
    </tr>)}</tbody></table></div>
  </section>
}
