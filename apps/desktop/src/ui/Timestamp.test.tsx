import { afterEach, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Timestamp } from './Timestamp.js';

const NOW = Date.parse('2026-07-06T19:42:02.000Z'); // frozen so relTime is deterministic

afterEach(() => vi.useRealTimers());

test('shows the relative word with the absolute UTC time as a tooltip', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  render(<Timestamp ms={Date.parse('2026-07-06T19:12:02.123Z')} className="tabular-nums" />);
  const el = screen.getByText('30m ago');
  expect(el).toHaveAttribute('title', '2026-07-06 19:12 UTC');
  expect(el).toHaveClass('tabular-nums');
});

test('renders an em dash for an unparseable timestamp', () => {
  // `Date.parse` of a malformed string is NaN: "NaNs ago" with a RangeError from the tooltip.
  render(<Timestamp ms={Date.parse('not a date')} />);
  expect(screen.getByText('—')).not.toHaveAttribute('title');
});
