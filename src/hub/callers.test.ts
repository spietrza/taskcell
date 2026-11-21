import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { HubUser } from './auth.js';
import { createCallerResolver, repoVisibility } from './callers.js';
import { saveTeams } from './teams.js';

const ownerUser: HubUser = { id: 'owner', email: 'o@x.test', name: 'O' };
const ann: HubUser = { id: 'ann', email: 'ann@x.test', name: 'Ann' };
const users = new Map<string, HubUser>([[ownerUser.id, ownerUser], [ann.id, ann]]);
const req = {} as IncomingMessage;
const resolver = (owner: HubUser = ownerUser, admins: string[] = []) =>
  createCallerResolver(
    { owner, userById: async (id) => users.get(id), sessionUser: async () => ann, deviceSessionUser: async (t) => (t === 'dev' ? ann : undefined) },
    { isAdmin: (u) => u !== undefined && admins.includes(u.id) },
  );

describe('request resolution', () => {
  it('the hub token is the owner', async () => {
    const r = resolver();
    const user = await r.userOf(req, 'tok', true);
    expect(user).toBe(ownerUser);
    expect(r.ofRequest(user!, true)).toEqual({ user: ownerUser, owner: true, hubAdmin: false });
  });

  it('a session user is a member, never the owner; a device token resolves to a user too', async () => {
    const r = resolver();
    const user = await r.userOf(req, undefined, false);
    expect(r.ofRequest(user!, false)).toEqual({ user: ann, owner: false, hubAdmin: false });
    expect(await r.userOf(req, 'dev', false)).toBe(ann);
  });

  it('a session hub admin is a hub admin, not the owner', async () => {
    expect(resolver(ownerUser, ['ann']).ofRequest(ann, false)).toEqual({ user: ann, owner: false, hubAdmin: true });
  });
});

describe('stored callers', () => {
  const stored = { userId: 'owner', owner: true };

  it('a stored owner: true after the owner id changed is not the owner', async () => {
    const r = resolver({ ...ownerUser, id: 'new-owner' });
    expect(await r.ofRegistration(stored)).toMatchObject({ user: { id: 'owner' }, owner: false });
    expect(await resolver().ofRegistration(stored)).toMatchObject({ owner: true });
  });

  it('a user that is gone is undefined', async () => {
    expect(await resolver().ofRegistration({ userId: 'ghost', owner: false })).toBeUndefined();
    expect(await resolver().recheck({ user: { id: 'ghost', email: '', name: '' }, owner: true })).toBeUndefined();
  });
});

describe('repoVisibility', () => {
  let cfg: string;
  let inside: string;
  let outside: string;
  beforeEach(async () => {
    cfg = await mkdtemp(join(tmpdir(), 'callers-cfg-'));
    inside = await mkdtemp(join(tmpdir(), 'callers-in-'));
    outside = await mkdtemp(join(tmpdir(), 'callers-out-'));
    await mkdir(join(inside, 'sub'));
    await saveTeams(cfg, [{ id: 't', name: 'T', members: [{ login: 'ann', role: 'member' }], repositories: [inside] }]);
  });

  it('a member sees their teams’ repositories (and paths inside), not others', async () => {
    const v = await repoVisibility(cfg, { user: ann, owner: false, hubAdmin: false });
    expect(v.has(inside)).toBe(true);
    expect(v.has(join(inside, 'sub'))).toBe(true);
    expect(v.has(outside)).toBe(false);
    expect(await v.hasResolved(outside)).toBe(false);
    expect(await v.hasResolved(join(inside, 'sub'))).toBe(true);
  });

  it('the owner sees everything', async () => {
    const v = await repoVisibility(cfg, { user: ownerUser, owner: true });
    expect(v.has(outside)).toBe(true);
  });
});
