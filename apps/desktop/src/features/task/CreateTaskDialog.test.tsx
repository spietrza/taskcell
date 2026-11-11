import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';

function Harness({ onCancel, busy = false }: { onCancel?: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Create task</button>
      {open && (
        <CreateTaskDialog
          source="GitHub"
          title="Fix login"
          bodyBytes={12}
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
