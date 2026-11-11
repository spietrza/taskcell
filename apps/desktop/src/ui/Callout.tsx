import type { ReactNode } from 'react'

export function Callout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={`not-prose my-3 p-3`}>
      <div className="mb-1 caption">{label}</div>
      {children}
    </div>
  )
}
