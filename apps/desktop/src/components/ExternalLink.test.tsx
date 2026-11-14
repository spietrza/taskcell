import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExternalLink, hostName } from './ExternalLink';

test('renders an ordinary new-tab link', () => {
  render(<ExternalLink href="https://github.com/o/r/pull/1">Open in GitHub</ExternalLink>);
  const a = screen.getByRole('link', { name: 'Open in GitHub' });
  expect(a).toHaveAttribute('href', 'https://github.com/o/r/pull/1');
  expect(a).toHaveAttribute('target', '_blank');
});

test('renders nothing without an address', () => {
  const { container } = render(<ExternalLink>Open in GitHub</ExternalLink>);
  expect(container).toBeEmptyDOMElement();
});

test('names the host from the pull/merge request path', () => {
  expect(hostName('https://github.com/o/r/pull/1')).toBe('GitHub');
  expect(hostName('https://gitlab.com/g/p/-/merge_requests/1')).toBe('GitLab');
});

test('in demo mode a link to the made-up repository goes nowhere; a real address still works', () => {
  window.__TASKCELL_DEMO__ = true;
  try {
    render(
      <>
        <ExternalLink href="https://github.com/demo-org/storefront/pull/101">Open in GitHub</ExternalLink>
        <ExternalLink href="https://example.com/docs">Docs</ExternalLink>
      </>,
    );
    expect(screen.getByText('Open in GitHub').closest('a')).not.toHaveAttribute('href');
    expect(screen.getByText('Docs').closest('a')).toHaveAttribute('href', 'https://example.com/docs');
  } finally {
    delete window.__TASKCELL_DEMO__;
  }
});
