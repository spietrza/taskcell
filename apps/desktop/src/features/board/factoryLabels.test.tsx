import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FactoryLabelChips, factoryLabels } from './factoryLabels';

test('only factory labels, in lifecycle order, whatever the spelling', () => {
  expect(factoryLabels(['bug', 'Needs Info', 'vanguard:running', 'ready for agent', 'taskcell::verify-failed'])).toEqual([
    'ready for agent', 'vanguard:running', 'taskcell::verify-failed', 'Needs Info',
  ]);
  expect(factoryLabels(undefined)).toEqual([]);
});

test('each chip says what it means; only needs info is the needs-you orange', () => {
  render(<FactoryLabelChips labels={['needs info', 'needs revision', 'frontend']} />);
  const info = screen.getByText('needs info');
  expect(info).toHaveAttribute('title', expect.stringContaining('asked a question'));
  expect(info.className).toContain('text-primary-text');
  expect(screen.getByText('needs revision').className).not.toContain('text-primary-text');
  expect(screen.queryByText('frontend')).toBeNull();
});
