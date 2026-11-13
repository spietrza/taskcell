import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ErrorNote } from './ErrorNote';

test('shows a human message and keeps the raw error in the details disclosure', () => {
  render(<ErrorNote title="Couldn't load" next="Reload." error="boom: 500" />);
  expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load");
  expect(screen.getByText('boom: 500').closest('details')).toBeInTheDocument();
});
