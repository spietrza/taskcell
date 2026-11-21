// Hub commands: Expo push tokens of the mobile app. One module per feature — contract, validation and handler live here;
// `pnpm gen:wire` derives Commands, COMMAND_NAMES and dispatch from it (see CONTRIBUTING.md).
import { parsePushPlatform, parsePushToken, registerPushToken, unregisterPushToken } from '../push.js';
import { defineCommands, type AuditSpec } from '../command-kit.js';

export interface PushCommands {
  /** HUB_ONLY: store an Expo push token for the signed-in caller (no RPC takes a user id). The hub pushes to it when something new waits for them. */
  register_push_token: { args: { token: string; platform: 'ios' | 'android' }; result: void };
  /** HUB_ONLY: remove the caller's own push token (another user's token is left alone). */
  unregister_push_token: { args: { token: string }; result: void };
}

/** The audit line never names the token. */
const spec = (action: 'push-register' | 'push-unregister'): AuditSpec => ({ action, target: () => 'push-token' });

export const commands = defineCommands<PushCommands>({
  register_push_token: async ({ ctx, caller, args }) => {
    await registerPushToken(ctx.configDir, { token: parsePushToken(args.token), platform: parsePushPlatform(args.platform), userId: caller.user.id, owner: caller.owner });
    return null;
  },
  unregister_push_token: async ({ ctx, caller, args }) => {
    await unregisterPushToken(ctx.configDir, parsePushToken(args.token), caller.user.id);
    return null;
  },
}, {
  register_push_token: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)' },
  unregister_push_token: { write: true, gatedBy: 'the signed-in caller\'s own scope (no user id is taken)' },
}, {
  register_push_token: spec('push-register'),
  unregister_push_token: spec('push-unregister'),
});
