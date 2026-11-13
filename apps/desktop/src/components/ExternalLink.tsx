import { ExternalLink as Icon } from 'lucide-react';

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
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 text-xs text-blue-500 hover:underline ${className ?? ''}`}
    >
      {children}
      <Icon className="size-3" aria-hidden />
    </a>
  );
}
