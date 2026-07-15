'use client'

import ConnectionPoolPanel from './ConnectionPoolPanel'
import WorkflowLibraryPanel from './WorkflowLibraryPanel'

export default function ComfyUiSettings() {
  return <div aria-label="ComfyUI settings" className="grid h-full min-h-0 min-w-0 2xl:grid-cols-2">
    <ConnectionPoolPanel />
    <div className="min-w-0 min-h-[32rem] border-t border-[var(--glass-stroke-base)] 2xl:border-l 2xl:border-t-0"><WorkflowLibraryPanel /></div>
  </div>
}
