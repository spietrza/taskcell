import { useRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function Trap() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} tabIndex={-1} data-testid="root">
      <input aria-label="first" />
      <button tabIndex={-1}>untabbable</button>
      <button>last</button>
    </div>
  );
}

test('Tab on the last tabbable wraps to the first; untabbable buttons are ignored', () => {
  render(<Trap />);
  screen.getByText('last').focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(document.activeElement).toBe(screen.getByLabelText('first'));
});

test('Shift+Tab on the first wraps to the last tabbable, and from the panel itself', () => {
  render(<Trap />);
  screen.getByLabelText('first').focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('last'));
  screen.getByTestId('root').focus();
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
  expect(document.activeElement).toBe(screen.getByText('last'));
});

test('focus returns to the opener on unmount', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const { unmount } = render(<Trap />);
  screen.getByLabelText('first').focus();
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

test('focus moves into the dialog when it opens, and back to the opener when it closes', () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const { unmount } = render(<Trap />);
  expect(document.activeElement).toBe(screen.getByLabelText('first'));
  unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
