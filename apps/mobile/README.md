# Taskcell mobile

Expo (React Native) iPhone app for a Taskcell hub. Four tabs like the hub's top bar: Home, Board, Runs, Settings (placeholders for now). The Connect screen takes the hub URL and the token `taskcell hub` prints, checks them with one read call (`list_projects`) through the shared hub client (`packages/hub-client`), and keeps them in the keychain via `expo-secure-store` only. Disconnect from Settings.

## Sign in to a server-mode hub

A hub with sign-in enabled (docs/hub.md, "Server mode sign-in") reports its providers at `/api/auth/native/providers`; the Connect screen then offers **Sign in with GitHub / GitLab / Google** next to the owner-token form (which stays for single-user hubs). Sign-in runs the hub's own Better Auth flow in the system browser (`expo-web-browser`), ends on `taskcell://auth`, and the app trades the one-time token it receives, with the PKCE verifier only it holds (`expo-crypto`), for a bearer session. That session is kept in the keychain (`expo-secure-store`, this device only) and sent as `Authorization: Bearer`; Home and Settings show who is signed in. A non-allowlisted account is refused with the hub's own message. **Disconnect** revokes the session on the hub (best effort when the hub is unreachable) and clears the keychain. The redirect is the fixed `taskcell://auth`, so sign-in needs a development or standalone build, not Expo Go.

**Sign in with Apple (App Store guideline 4.8): exempt, not offered.** The app is a client for a hub the user's own team self-hosts. The third-party providers only authenticate members against that hub's operator-controlled allowlist (the enterprise-account exemption: "apps that require the user to sign in with an existing education or enterprise account"), the app has no accounts of its own, and the owner-token path needs no third-party login at all. If a store review disagrees, add Apple as a hub provider (docs/hub.md notes it as planned) and list it here.

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
