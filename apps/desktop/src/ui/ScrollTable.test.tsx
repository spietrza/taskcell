import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { ScrollTable } from './ScrollTable';

test('the scrolling wrapper carries the edge cue for columns hidden sideways', () => {
  const { container } = render(
    <ScrollTable>
      <div>table</div>
    </ScrollTable>,
  );
  expect(container.firstElementChild?.className).toContain('[&>div]:scroll-cue-x');
});
