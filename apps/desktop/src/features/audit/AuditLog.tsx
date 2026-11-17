import { useState } from 'react';
import { Table, Chip, Input, ScrollTable, Timestamp } from '@/ui';
import { callerCapabilities, readAudit } from '../../ipc';
import { useAsync, usePhone } from '../../hooks';

/** Read-only audit view, for admins: the hub's `caller_capabilities` says whether the caller is one. */
export function AuditLog() {
  const [login, setLogin] = useState('');
  const phone = usePhone();
  const { data, error, loading } = useAsync(async () => ((await callerCapabilities()).admin ? readAudit(login.trim() || undefined) : 'not-admin' as const), [login]);
  if (data === 'not-admin') return <div className="py-8 text-center text-sm text-muted-foreground">The audit log is for hub admins.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Filter by login…" aria-label="Filter by login" className="w-56 max-md:w-full" />
      {error !== null ? (
        <div role="alert" className="text-sm text-destructive">{error}</div>
      ) : loading && data === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : data === null || data.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">No audit entries.</div>
      ) : phone ? (
        // A phone stacks each entry, outcome first, instead of a five-column table that scrolls it off-screen.
        <ul aria-label="Audit entries" className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {data.map((e, i) => (
            <li key={`${e.time}:${i}`} className="space-y-1 px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{e.action}</span>
                <Chip color={e.outcome === 'ok' ? 'success' : 'warning'} variant="outlined">{e.outcome}</Chip>
              </div>
              <div className="break-words text-xs text-muted-foreground">
                {e.target ?? '—'}
                {e.detail !== undefined && e.detail.length > 0 ? ` (${e.detail.join(', ')})` : ''}
              </div>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">{e.login}</span>
                <Timestamp ms={Date.parse(e.time)} className="ml-auto shrink-0 tabular-nums" />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ScrollTable>
          <Table.Root>
            <Table.Header className="sticky top-0 z-10 bg-background [&_th]:caption">
              <Table.Row>
                <Table.Head>When</Table.Head>
                <Table.Head>Login</Table.Head>
                <Table.Head>Action</Table.Head>
                <Table.Head>Target</Table.Head>
                <Table.Head>Outcome</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.map((e, i) => (
                <Table.Row key={`${e.time}:${i}`}>
                  <Table.Cell className="tabular-nums text-muted-foreground"><Timestamp ms={Date.parse(e.time)} /></Table.Cell>
                  <Table.Cell>{e.login}</Table.Cell>
                  <Table.Cell>{e.action}</Table.Cell>
                  <Table.Cell className="text-muted-foreground">
                    {e.target ?? '—'}
                    {e.detail !== undefined && e.detail.length > 0 ? ` (${e.detail.join(', ')})` : ''}
                  </Table.Cell>
                  <Table.Cell>
                    <Chip color={e.outcome === 'ok' ? 'success' : 'warning'} variant="outlined">{e.outcome}</Chip>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </ScrollTable>
      )}
    </div>
  );
}
