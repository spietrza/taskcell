# Taskcell mobile

Expo (React Native) iPhone app for a Taskcell hub. Four tabs like the hub's top bar: Home, Board, Runs, Settings (placeholders for now). The Connect screen takes the hub URL and the token `taskcell hub` prints, checks them with one read call (`list_projects`) through the shared hub client (`packages/hub-client`), and keeps them in the keychain via `expo-secure-store` only. Disconnect from Settings. Better Auth sign-in is a later card.

## Run

```sh
pnpm install
pnpm start        # npx expo start
```

Start a hub that listens on your network (e.g. `taskcell hub`, see the root README for the host/port flags) and note the URL and token it prints.

**iOS simulator:** press `i` in the Expo terminal (needs Xcode). Use `http://127.0.0.1:<port>` as the hub URL.

**Phone with Expo Go:** install Expo Go, join the same Wi-Fi as the machine running the hub, scan the QR code from `expo start`. Enter `http://<your-machine-LAN-IP>:<port>` as the hub URL (not `127.0.0.1`) and the token.

## Checks

```sh
pnpm typecheck
pnpm test         # jest-expo, connect flow against a fake hub
```

CI does not run these yet; that needs a workflow edit by a human.
