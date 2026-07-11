'use client'

import ConnectionPoolPanel from './ConnectionPoolPanel'
import WorkflowLibraryPanel from './WorkflowLibraryPanel'

export default function ComfyUiSettings() {
  return <div aria-label="ComfyUI settings" className="grid h-full min-h-0 xl:grid-cols-2">
    <ConnectionPoolPanel />
    <div className="min-h-[32rem] border-t border-[var(--glass-stroke-base)] xl:border-l xl:border-t-0"><WorkflowLibraryPanel /></div>
  </div>
}
