'use client'

import React, { useState } from 'react'
import { useTranslations } from 'next-intl'
import WorkflowAutoMappingTable, { type WorkflowAutoMappingTableProps } from './WorkflowAutoMappingTable'

export default function WorkflowAdvancedMappingInspector(props: WorkflowAutoMappingTableProps) {
  const t = useTranslations('comfyui.workflows.guided')
  const [hasOpened, setHasOpened] = useState(false)

  return <details
    className="glass-surface-soft min-w-0 rounded-xl p-4"
    onToggle={(event) => {
      if (event.currentTarget.open) setHasOpened(true)
    }}
  >
    <summary className="cursor-pointer break-words text-sm font-medium">{t('advancedSettings')}</summary>
    {hasOpened && <div className="mt-4 min-w-0 overflow-x-auto">
      <WorkflowAutoMappingTable {...props} />
    </div>}
  </details>
}
