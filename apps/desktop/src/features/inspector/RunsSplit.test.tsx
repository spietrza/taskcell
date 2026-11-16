import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunsSplit } from './RunsSplit';

// jsdom evaluates no media query: the narrow rule is the `max-md:hidden` class on the side that is not shown.
test('nothing open: the list and the (empty) pane are both in the split; on a narrow screen the list alone shows', () => {
  render(<RunsSplit open={false} list={<p>the list</p>} pane={<p>the pane</p>} />);
  expect(screen.getByTestId('runs-list')).not.toHaveClass('max-md:hidden');
  expect(screen.getByTestId('runs-pane')).toHaveClass('max-md:hidden');
  expect(screen.getByTestId('runs-split')).toHaveAttribute('data-open', 'false');
});

test('a run open: on a narrow screen the pane fills it and the list steps aside; on a wide one both stay', () => {
  render(<RunsSplit open list={<p>the list</p>} pane={<p>the pane</p>} />);
  expect(screen.getByTestId('runs-list')).toHaveClass('max-md:hidden', 'md:w-[26rem]');
  expect(screen.getByTestId('runs-pane')).not.toHaveClass('max-md:hidden');
  expect(screen.getByText('the list')).toBeInTheDocument();
  expect(screen.getByText('the pane')).toBeInTheDocument();
});
