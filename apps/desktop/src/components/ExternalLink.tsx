import { ExternalLink as Icon } from 'lucide-react';
import { isDemoLink } from '../transport';

/** The Git host a pull/merge request address belongs to, by its path (`/pull/N` vs `/-/merge_requests/N`). */
export function hostName(url: string): 'GitHub' | 'GitLab' {
  return url.includes('/-/merge_requests/') ? 'GitLab' : 'GitHub';
}

/**
 * An ordinary link out to the original system (new tab, copyable). The address always comes from the
 * server; with none, nothing is rendered.
 */
export function ExternalLink({ href, children, className }: { href?: string; children: string; className?: string }) {
  if (href === undefined || href === '') return null;
  // The demo's repository does not exist: its links stay visible but go nowhere.
  const inert = isDemoLink(href);
  return (
    <a
      href={inert ? undefined : href}
      title={inert ? 'Demo project: this link goes nowhere.' : undefined}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 text-xs text-primary-text hover:underline ${className ?? ''}`}
    >
      {children}
      <Icon className="size-3" aria-hidden />
    </a>
  );
}
