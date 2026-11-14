import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CreateTaskDialog, createFailureText } from './CreateTaskDialog';
import { DEMO_READ_ONLY_MESSAGE } from '../../errors';
import { NO_REMOTE_MESSAGE } from '../../wire';

function Harness({ onCancel, busy = false }: { onCancel?: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Create task</button>
      {open && (
        <CreateTaskDialog
          source="github"
          title="Fix login"
          bodyBytes={12}
          branches={[]}
          baseBranch=""
          onBaseBranch={() => {}}
          busy={busy}
          onConfirm={() => {}}
          onCancel={() => {
            onCancel?.();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

describe('CreateTaskDialog', () => {
  test('is a named modal dialog that takes focus and returns it to the opener on close', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Create task' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Create a task on GitHub?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test('Escape does nothing while the create is in flight', () => {
    const onCancel = vi.fn();
    render(<Harness onCancel={onCancel} busy />);
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

test('a refusal is shown as is; any other create failure sends the user to check the tracker, with single punctuation', () => {
  expect(createFailureText(DEMO_READ_ONLY_MESSAGE, 'github')).toBe(DEMO_READ_ONLY_MESSAGE);
  expect(createFailureText(NO_REMOTE_MESSAGE, 'github')).toBe(NO_REMOTE_MESSAGE);
  expect(createFailureText('gh: timed out.', 'github')).toBe('gh: timed out — the issue may or may not have been created. Check GitHub before retrying.');
});
