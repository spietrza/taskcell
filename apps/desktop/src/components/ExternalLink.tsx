import { ExternalLink as Icon } from 'lucide-react';
import { isDemoLink } from '../transport';

/** The Git host a pull/merge request address belongs to, by its path (`/pull/N` vs `/-/merge_requests/N`). */
export function hostName(url: string): 'GitHub' | 'GitLab' {
  return url.includes('/-/merge_requests/') ? 'GitLab' : 'GitHub';
}

const PR_URL = /^(.+)\/(pull|-\/merge_requests)\/\d+\/?$/;

/** The issue's address in the same repository as its PR/MR (`…/pull/5` → `…/issues/<issue>`); undefined for any other address. */
export function issueUrl(prUrl: string, issue: number): string | undefined {
  const m = PR_URL.exec(prUrl);
  return m ? `${m[1]}/${m[2] === 'pull' ? 'issues' : '-/issues'}/${issue}` : undefined;
}

/**
 * An ordinary link out to the original system (new tab, copyable). The address always comes from the
 * server; with none, nothing is rendered.
 */
export function ExternalLink({ href, children, className }: { href?: string; children: string; className?: string }) {
  if (href === undefined || href === '') return null;
  // The demo's repository does not exist: its links show as plain text that says so.
  if (isDemoLink(href)) {
    return (
      <span title="Demo project: this link goes nowhere." onClick={(e) => e.stopPropagation()} className={`text-xs text-muted-foreground ${className ?? ''}`}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
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
