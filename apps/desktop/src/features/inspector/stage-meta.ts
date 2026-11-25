import { estLabel } from '../../cost'
import type { RunRecord } from '../../taskcell-output'

export function buildStageMeta(r: RunRecord): string[] {
  const seconds = r.durationMs ? Math.round(r.durationMs / 1000) : 0

  return [
    `${r.turns} turns`,
    `${seconds}s`,
    r.usage ? `${r.usage.inputTokens}/${r.usage.outputTokens} tok` : null,
    r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : estLabel(r.estCostUsd) ?? null,
    r.model ?? 'unknown model',
  ].filter((x): x is string => x !== null)
}

const clock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Which entry a stage ran on and the limit that moved it there; undefined unless a provider limit moved the stage. */
export function fallbackLine(r: RunRecord): string | undefined {
  const p = r.modelPick
  if (p === undefined || (p.pick !== 'fallback' && p.pick !== 'skip-limit')) return undefined
  const used = `${p.provider}${p.model !== undefined ? `/${p.model}` : ''}`
  const why = (p.skipped ?? []).map((s) => `${s.entry} hit its limit${s.until !== undefined ? ` (resets ${clock(s.until)})` : ''}`)
  return `Ran on ${used} — fallback${why.length > 0 ? `: ${why.join('; ')}` : ' after a provider limit'}`
}
