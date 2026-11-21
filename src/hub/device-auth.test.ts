import { describe, expect, test } from 'vitest';
import { DEVICE_CODE_TTL_MS, DeviceAuth, MAX_PENDING_CODES, MAX_PENDING_CODES_PER_IP, MAX_USER_CODE_FAILURES, USER_CODE_WINDOW_MS, clientKey, csrfOk, normalizeUserCode } from './device-auth.js';

describe('DeviceAuth', () => {
  test('pending -> approved once; the user code decides once', () => {
    let t = 1_000_000;
    const d = new DeviceAuth(() => t);
    const c = d.start()!;
    expect(DEVICE_CODE_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
    expect(d.poll(c.device_code).status).toBe('pending');
    t += 10_000;
    expect(d.decide(c.user_code, 'u1', true)).toBe('approved');
    expect(d.decide(c.user_code, 'u2', true)).toBe('invalid');
    expect(d.poll(c.device_code)).toEqual({ status: 'approved', userId: 'u1' });
    expect(d.poll(c.device_code).status).toBe('invalid_grant');
  });

  test('polling faster than the interval is told to slow down', () => {
    let t = 1_000_000;
    const d = new DeviceAuth(() => t);
    const c = d.start()!;
    d.poll(c.device_code);
    t += 1000;
    expect(d.poll(c.device_code).status).toBe('slow_down');
  });

  test('an expired code is refused to the app and to the approver', () => {
    let t = 1_000_000;
    const d = new DeviceAuth(() => t);
    const c = d.start()!;
    t += DEVICE_CODE_TTL_MS;
    expect(d.decide(c.user_code, 'u1', true)).toBe('invalid');
    expect(d.poll(c.device_code).status).toBe('expired_token');
    expect(d.poll(c.device_code).status).toBe('invalid_grant');
  });

  test('guessing is bounded per approver and window; pending codes are capped', () => {
    let t = 1_000_000;
    const d = new DeviceAuth(() => t);
    const c = d.start()!;
    for (let i = 0; i < MAX_USER_CODE_FAILURES; i++) expect(d.decide('BBBBBBBB', 'u1', true)).toBe('invalid');
    expect(d.decide(c.user_code, 'u1', true)).toBe('locked');
    expect(d.lookup(c.user_code, 'u1')).toBe('locked');
    // The lockout is per approver: another member's code entry still works.
    expect(d.lookup(c.user_code, 'u2')).toEqual({ requestedAt: 1_000_000 });
    expect(d.decide(c.user_code, 'u2', true)).toBe('approved');
    t += USER_CODE_WINDOW_MS;
    expect(d.decide(d.start()!.user_code, 'u1', true)).toBe('approved');
    const full = new DeviceAuth(() => t);
    for (let i = 0; i < MAX_PENDING_CODES; i++) expect(full.start(`ip${i % 10}`)).not.toBeNull();
    expect(full.start('another')).toBeNull();
    const one = new DeviceAuth(() => t);
    for (let i = 0; i < MAX_PENDING_CODES_PER_IP; i++) expect(one.start('1.2.3.4')).not.toBeNull();
    expect(one.start('1.2.3.4')).toBeNull();
    expect(one.start('5.6.7.8')).not.toBeNull();
  });

  test('IPv6 clients are counted per /64', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:bbbb:0:0:2'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    const d = new DeviceAuth(() => 1_000_000);
    for (let i = 0; i < MAX_PENDING_CODES_PER_IP; i++) expect(d.start(`2001:db8:1:2::${i + 1}`)).not.toBeNull();
    expect(d.start('2001:db8:1:2:ffff::9')).toBeNull();
  });

  test('helpers', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK');
    expect(csrfOk('abc', 'abc')).toBe(true);
    expect(csrfOk('abc', 'abd')).toBe(false);
    expect(csrfOk(undefined, 'abc')).toBe(false);
  });
});
