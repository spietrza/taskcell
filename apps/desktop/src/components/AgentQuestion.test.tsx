import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { AgentQuestion } from './AgentQuestion';

test('the agent question renders no images and links only http(s) addresses', () => {
  const { container } = render(<AgentQuestion>{'**Which file?** ![x](http://evil/img) [a](javascript:alert(1)) [docs](https://example.com/d)'}</AgentQuestion>);
  expect(container.querySelector('strong')).toHaveTextContent('Which file?');
  expect(container.querySelector('img')).toBeNull();
  const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(links).toEqual(['https://example.com/d']);
  expect(container).toHaveTextContent('a');
});
