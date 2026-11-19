import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { Markdown } from './Markdown';

test('markdown links open in a new tab without opener or referrer', () => {
  render(<Markdown>{'[x](https://evil.example/x)'}</Markdown>);
  const a = screen.getByRole('link', { name: 'x' });
  expect(a).toHaveAttribute('href', 'https://evil.example/x');
  expect(a).toHaveAttribute('target', '_blank');
  expect(a).toHaveAttribute('rel', 'noopener noreferrer');
});

test('a markdown link with another scheme renders as text', () => {
  const { container } = render(<Markdown>{'[x](data:text/html,hi)'}</Markdown>);
  expect(container.querySelector('a')).toBeNull();
  expect(container).toHaveTextContent('x');
});
