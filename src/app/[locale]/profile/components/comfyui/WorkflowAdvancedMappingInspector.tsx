'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import WorkflowAutoMappingTable, { type WorkflowAutoMappingTableProps } from './WorkflowAutoMappingTable'

export default function WorkflowAdvancedMappingInspector(props: WorkflowAutoMappingTableProps) {
  const t = useTranslations('comfyui.workflows.guided')

  return <details className="glass-surface-soft min-w-0 rounded-xl p-4">
    <summary className="cursor-pointer break-words text-sm font-medium">{t('advancedSettings')}</summary>
    <div className="mt-4 min-w-0 overflow-x-auto">
      <WorkflowAutoMappingTable {...props} />
    </div>
  </details>
}
