# Taskcell mobile

Expo (React Native) iPhone app for a Taskcell hub. Four tabs like the hub's top bar: Home, Board, Runs, Settings (placeholders for now). The Connect screen takes the hub URL and the token `taskcell hub` prints, checks them with one read call (`list_projects`) through the shared hub client (`packages/hub-client`), and keeps them in the keychain via `expo-secure-store` only. When the hub has server-mode sign-in, the Connect screen also offers **Sign in**: the app shows a short code, opens the hub's `/device` page in the browser, where the member signs in and types the code; the app then receives a member session (see docs/hub.md, "Mobile sign-in (device flow)"). The hub must have `TASKCELL_HUB_PUBLIC_URL` set for Sign in to work: without it the verification URL is the hub's bind address and the app refuses it. No `taskcell://` redirect carries a session or token. The keychain item records the kind (owner token or member session). Disconnect in Settings revokes a member session on the hub and clears the keychain.

## App Store guideline 4.8 (Sign in with Apple)

The app itself offers no third-party login: it only opens the operator's own hub, whose sign-in page is the operator's choice of GitHub, GitLab or Google. We treat the app as exempt from 4.8 as a client for a specific enterprise/self-hosted service that users sign in to with an account for that service (the hub's allowlist decides who may), not a general social-login app. Sign in with Apple is therefore not offered. If review disagrees, the fix is a hub-side provider, not an app change.

## Run

```sh
pnpm install
pnpm start        # npx expo start
```

Start a hub that listens on your network (e.g. `taskcell hub`, see the root README for the host/port flags) and note the URL and token it prints.

**iOS simulator:** press `i` in the Expo terminal (needs Xcode). Use `http://127.0.0.1:<port>` as the hub URL.

**Phone with Expo Go:** install Expo Go, join the same Wi-Fi as the machine running the hub, scan the QR code from `expo start`. Enter `http://<your-machine-LAN-IP>:<port>` as the hub URL (not `127.0.0.1`) and the token.

**Cleartext HTTP:** a plain `http://` URL to anything but loopback (`127.0.0.1`, `localhost`, `[::1]`) sends the hub token unencrypted over the network, so the Connect screen shows a warning. Expo Go allows HTTP; a standalone iOS build does not (App Transport Security blocks it), so it needs the hub behind HTTPS (e.g. a reverse proxy with a certificate).

## Checks

```sh
pnpm typecheck
pnpm test         # jest-expo, connect flow against a fake hub
```

`pnpm verify` at the repo root runs both (`verify:mobile`), so CI and the factory gate cover them.

## Push notifications

When something new waits for you (PR ready, question, too vague, changes requested) the hub sends a push through Expo's push service (APNs on iOS). The app asks for notification permission right after you connect (never on first launch), registers its Expo push token with the hub (`register_push_token`), and unregisters it on **Disconnect** (`unregister_push_token`). Settings has a **Notifications** switch. If you deny permission the app works as before, without push. Tapping a notification opens Home with that item's sheet.

Setup: nothing in the app beyond `expo-notifications` (already a dependency); the push token is issued for the EAS project in `app.json` (`extra.eas.projectId`, `@taskcell/taskcell-mobile`), so a fork that builds its own app runs `eas init` to replace it. Expo Go on an iPhone simulator can receive real pushes only on a physical device; on the simulator verify registration and the hub's log. The hub must be able to reach `https://exp.host`. See [docs/hub.md](../../docs/hub.md#push-notifications).

## Release

Profiles are in `eas.json`: `development` (dev client, simulator build), `preview` (internal distribution) and `production` (App Store / TestFlight, build number auto-increments remotely). The bundle id is `dev.taskcell.mobile`; the version comes from `package.json`. ATS is left at its default, so the hub must be served over HTTPS.

```sh
npx eas-cli login
eas build -p ios --profile production
eas submit -p ios            # uploads the build to App Store Connect / TestFlight
```

Needs a paid Apple Developer Program account: device and distribution builds, signing, TestFlight and push (APNs). Simulator builds (`development`) and Expo Go do not.

Secrets live in EAS, not in the repo: the signing certificate and provisioning profile (managed by EAS credentials), the APNs key, and the App Store Connect API key used by `eas submit`. The repo holds no credentials, Apple team ids or API keys; `eas credentials` and `eas submit` prompt for them, or read them from EAS secrets. Forks run `eas init` to get their own project id (see Push notifications).

## Reaching a hub on your Mac

From outside your home network, without a VPS: see [docs/mobile-remote.md](../../docs/mobile-remote.md) (Tailscale, Cloudflare Tunnel).
