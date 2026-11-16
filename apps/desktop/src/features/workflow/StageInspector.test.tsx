import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StageInspector } from './StageInspector';

describe('StageInspector model pool', () => {
  it('edits a stage pool entry by entry and writes the weighted pool back as the stage model', () => {
    const onSetOverride = vi.fn();
    render(
      <StageInspector
        stage={{ name: 'implementer', overrides: { model: 'claude/sonnet:3, codex/gpt-5.6-sol:1' } }}
        palette={['implementer']}
        providers={['claude', 'codex']}
        onSetName={() => {}}
        onSetRef={() => {}}
        onSetOverride={onSetOverride}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByLabelText('pool entry 2 id')).toHaveValue('gpt-5.6-sol');
    fireEvent.change(screen.getByLabelText('pool weight 2'), { target: { value: '2' } });
    expect(onSetOverride).toHaveBeenLastCalledWith('model', 'claude/sonnet:3, codex/gpt-5.6-sol:2');
    fireEvent.click(screen.getByLabelText('remove pool entry 1'));
    expect(onSetOverride).toHaveBeenLastCalledWith('model', 'codex/gpt-5.6-sol:2');
  });
});
