import { test, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatModelField } from './ChatModelField';
import * as ipc from '../../ipc';
import { CHAT_MODELS } from '../../wire';

vi.mock('../../ipc.js', () => ({ listChatModels: vi.fn() }));
const list = vi.mocked(ipc.listChatModels);

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <ChatModelField project="/repo" value={v} onChange={(x) => setV(x ?? '')} />;
}

test('picks a known model, and a typed model stays possible', () => {
  render(<Harness />);
  const typed = screen.getByPlaceholderText('claude-sonnet-5');
  const known = screen.getByRole('combobox', { name: 'Known models' });
  expect([...(known as HTMLSelectElement).options].slice(1).map((o) => o.value)).toEqual([...CHAT_MODELS]);
  fireEvent.change(known, { target: { value: CHAT_MODELS[1] } });
  expect(typed).toHaveValue(CHAT_MODELS[1]);
  fireEvent.change(typed, { target: { value: 'my-own-model' } });
  expect(known).toHaveValue('');
  expect(typed).toHaveValue('my-own-model');
});

test('Fetch models replaces the list with what the hub read, and names where from', async () => {
  list.mockResolvedValueOnce({ source: 'endpoint', origin: 'https://llm.example.com', models: ['glm-5.2', 'glm-5.2-air'] });
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByRole('status')).toHaveTextContent('2 models from https://llm.example.com.');
  expect(list).toHaveBeenCalledWith('/repo');
  const known = screen.getByRole('combobox', { name: 'Known models' }) as HTMLSelectElement;
  expect([...known.options].slice(1).map((o) => o.value)).toEqual(['glm-5.2', 'glm-5.2-air']);
});

test("a failed fetch says why and keeps the list it had", async () => {
  list.mockResolvedValueOnce({ source: 'endpoint', origin: 'https://llm.example.com', models: [], error: 'https://llm.example.com answered HTTP 401' });
  render(<Harness initial="claude-opus-5-5" />);
  fireEvent.click(screen.getByRole('button', { name: 'Fetch models' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Models could not be listed: https://llm.example.com answered HTTP 401.');
  expect(screen.getByRole('combobox', { name: 'Known models' })).toHaveValue('claude-opus-5-5');
});
