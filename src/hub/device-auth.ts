// Device authorization (RFC 8628 shape) for the mobile app: the app holds a secret `device_code` and shows a
// short `user_code`; a member signs in in the browser, TYPES the code on /device and approves with a CSRF POST;
// the app's poll then receives a hub session. Nothing here rides a custom-scheme redirect. State is in memory:
// a hub restart simply invalidates pending codes. Docs: docs/hub.md "Mobile sign-in (device flow)".
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** A code lives at most this long (RFC 8628 `expires_in`). */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Minimum seconds between polls of one device code; faster polling is told `slow_down`. */
export const DEVICE_POLL_INTERVAL_S = 5;
/** Pending codes held at once: `POST /api/device/code` is unauthenticated, so it is bounded. */
export const MAX_PENDING_CODES = 200;
/** Pending codes one client address may hold at once (behind a reverse proxy every client shares the proxy's address). */
export const MAX_PENDING_CODES_PER_IP = 20;
/** Wrong `user_code` entries one approver may make per window before their code entry is locked. */
export const MAX_USER_CODE_FAILURES = 5;
export const USER_CODE_WINDOW_MS = 10 * 60_000;

// No vowels or look-alikes: a typed code cannot spell a word or be misread (20^8 ≈ 2.6e10 codes).
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

interface Entry {
  userCode: string;
  expiresAt: number;
  lastPollMs: number;
  ip: string;
  userId?: string;
  denied?: boolean;
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant' }
  | { status: 'approved'; userId: string };

export type DeviceApproval = 'approved' | 'denied' | 'invalid' | 'locked';
/** A typed code checked before deciding: when it was requested (epoch ms), or why it cannot be decided. */
export type DeviceLookup = { requestedAt: number } | 'invalid' | 'locked';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
/** `bcdf-ghjk` / `BCDFGHJK` → `BCDFGHJK`. */
export const normalizeUserCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z]/g, '');

export class DeviceAuth {
  private readonly byDevice = new Map<string, Entry>(); // sha256(device_code) -> entry
  private readonly byUser = new Map<string, string>(); // user_code -> sha256(device_code)
  private readonly failures = new Map<string, number[]>(); // approver id -> failure timestamps

  constructor(private readonly now: () => number = Date.now) {}

  /** Null when too many codes are pending, in total or from `ip` (the caller answers 429). */
  start(ip = ''): { device_code: string; user_code: string; expires_in: number; interval: number } | null {
    this.sweep();
    if (this.byDevice.size >= MAX_PENDING_CODES) return null;
    let fromIp = 0;
    for (const e of this.byDevice.values()) if (e.ip === ip) fromIp++;
    if (fromIp >= MAX_PENDING_CODES_PER_IP) return null;
    let userCode: string;
    do userCode = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    while (this.byUser.has(userCode));
    const deviceCode = randomBytes(32).toString('hex');
    const key = hash(deviceCode);
    this.byDevice.set(key, { userCode, expiresAt: this.now() + DEVICE_CODE_TTL_MS, lastPollMs: 0, ip });
    this.byUser.set(userCode, key);
    return { device_code: deviceCode, user_code: userCode, expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
  }

  /** The app's poll. An approved code is consumed here: it can be redeemed once. */
  poll(deviceCode: string): DevicePoll {
    const key = hash(deviceCode);
    const entry = this.byDevice.get(key);
    if (entry === undefined) return { status: 'invalid_grant' };
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.drop(key, entry);
      return { status: 'expired_token' };
    }
    if (entry.denied === true) {
      this.drop(key, entry);
      return { status: 'access_denied' };
    }
    if (entry.userId !== undefined) {
      this.drop(key, entry);
      return { status: 'approved', userId: entry.userId };
    }
    const tooFast = entry.lastPollMs !== 0 && now - entry.lastPollMs < DEVICE_POLL_INTERVAL_S * 1000;
    entry.lastPollMs = now;
    return { status: tooFast ? 'slow_down' : 'pending' };
  }

  /** The approver typed `rawUserCode` and reviews it before deciding. A wrong entry counts against the approver. */
  lookup(rawUserCode: string, approverId: string): DeviceLookup {
    const found = this.find(rawUserCode, approverId);
    return typeof found === 'string' ? found : { requestedAt: found.entry.expiresAt - DEVICE_CODE_TTL_MS };
  }

  /** The approver typed `rawUserCode`. Wrong entries count against that approver only: one member cannot lock out the others. */
  decide(rawUserCode: string, approverId: string, approve: boolean): DeviceApproval {
    const found = this.find(rawUserCode, approverId);
    if (typeof found === 'string') return found;
    this.byUser.delete(found.typed);
    if (approve) found.entry.userId = approverId;
    else found.entry.denied = true;
    return approve ? 'approved' : 'denied';
  }

  private find(rawUserCode: string, approverId: string): { typed: string; entry: Entry } | 'invalid' | 'locked' {
    const now = this.now();
    const mine = (this.failures.get(approverId) ?? []).filter((t) => now - t < USER_CODE_WINDOW_MS);
    if (mine.length >= MAX_USER_CODE_FAILURES) return 'locked';
    const typed = normalizeUserCode(rawUserCode);
    const key = this.byUser.get(typed);
    const entry = key === undefined ? undefined : this.byDevice.get(key);
    // Already approved/denied codes count as unknown: a user_code decides once.
    if (key === undefined || entry === undefined || entry.expiresAt <= now || entry.userId !== undefined || entry.denied === true) {
      mine.push(now);
      this.failures.set(approverId, mine);
      return 'invalid';
    }
    return { typed, entry };
  }

  private drop(key: string, entry: Entry): void {
    this.byDevice.delete(key);
    this.byUser.delete(entry.userCode);
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, e] of this.byDevice) if (e.expiresAt <= now) this.drop(key, e);
    for (const [id, ts] of this.failures) if (ts.every((t) => now - t >= USER_CODE_WINDOW_MS)) this.failures.delete(id);
  }
}

/** CSRF token for the verification page: the same random value in an HttpOnly cookie and a hidden field. */
export const newCsrfToken = (): string => randomBytes(24).toString('hex');
export function csrfOk(cookie: string | undefined, field: string | undefined): boolean {
  if (!cookie || !field) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(field);
  return a.length === b.length && timingSafeEqual(a, b);
}
