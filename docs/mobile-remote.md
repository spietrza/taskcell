# Reach a Mac hub from your phone (no VPS)

The hub runs on your Mac; the phone app (`apps/mobile`) connects to its URL. Two ways to reach it from outside your home network. Either way:

- **Every recipe here runs the hub in server mode** (a bind beyond loopback, or `TASKCELL_HUB_SERVER_MODE=1` on `127.0.0.1` behind `tailscale serve` or a tunnel, which is public to everyone who reaches that name; never omit it). In server mode `taskcell hub` prints only the bare URL, never the token, and without `--token-file` the token is a fresh one per launch you cannot read. So each recipe passes `--token-file ~/.taskcell/hub-token` (created mode 0600 on first start, kept across restarts). A reachable URL is not access.
- **Log in from the phone** in one of two ways:
  - *Owner token*: on the Mac run `cat ~/.taskcell/hub-token` and paste it into the Connect screen's **Hub token** field with the Connect URL. Anyone holding it is the owner: keep it private (`taskcell hub rotate-token --token-file ~/.taskcell/hub-token`, then restart, replaces it).
  - *Sign in*: configure a provider (`TASKCELL_HUB_AUTH_GITHUB_CLIENT_ID`/`_SECRET`, or GitLab/Google), `TASKCELL_HUB_SIGNUP_ALLOW` and `TASKCELL_HUB_PUBLIC_URL` set to the Connect URL; the app then offers **Sign in** (device flow, the browser opens `/device` on that URL). See [hub.md](hub.md#server-mode-sign-in) and [Mobile sign-in](hub.md#mobile-sign-in-device-flow).
- **Standalone iOS builds need HTTPS** (App Transport Security blocks plain `http://`). Expo Go allows HTTP, so `http://` works for development only.
- The hub checks `Host` and requires a matching `Origin` on mutating calls. A hostname (not an IP) must be listed with `--allowed-host`; the app sends the hub's own origin, so no other change is needed. See [hub.md](hub.md).

## Tailscale

Install Tailscale on the Mac and the phone, same tailnet.

```sh
tailscale ip -4                      # e.g. 100.64.0.5
tailscale status                     # shows <mac>.<tailnet>.ts.net
TASKCELL_HUB_PUBLIC_URL=http://<mac>.<tailnet>.ts.net:7777 taskcell hub --repo /path/to/repo --host 100.64.0.5 --allowed-host <mac>.<tailnet>.ts.net:7777 --token-file ~/.taskcell/hub-token
cat ~/.taskcell/hub-token            # the Hub token for the Connect screen
```

Connect URL: `http://<mac>.<tailnet>.ts.net:7777` (Expo Go / development builds only; a TestFlight or App Store build needs one of the HTTPS recipes below). The Tailscale IP itself needs no `--allowed-host`.

For HTTPS (required for standalone builds), enable HTTPS certificates in the Tailscale admin console, keep the hub on loopback and let Tailscale serve it:

```sh
TASKCELL_HUB_SERVER_MODE=1 TASKCELL_HUB_PUBLIC_URL=https://<mac>.<tailnet>.ts.net taskcell hub --repo /path/to/repo --allowed-host <mac>.<tailnet>.ts.net --token-file ~/.taskcell/hub-token
tailscale serve --bg --https=443 http://127.0.0.1:7777
cat ~/.taskcell/hub-token            # the Hub token for the Connect screen
```

Connect URL: `https://<mac>.<tailnet>.ts.net`.

## Cloudflare Tunnel

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create taskcell
cloudflared tunnel route dns taskcell hub.example.com
TASKCELL_HUB_SERVER_MODE=1 TASKCELL_HUB_PUBLIC_URL=https://hub.example.com taskcell hub --repo /path/to/repo --allowed-host hub.example.com --token-file ~/.taskcell/hub-token
cloudflared tunnel run --url http://127.0.0.1:7777 taskcell
cat ~/.taskcell/hub-token            # the Hub token for the Connect screen
```

Connect URL: `https://hub.example.com` (HTTPS end to end).

For a quick test without a domain, start the tunnel first: `cloudflared tunnel --url http://127.0.0.1:7777` prints a random `https://<name>.trycloudflare.com`. Then start the hub in server mode for that host, the same way:

```sh
TASKCELL_HUB_SERVER_MODE=1 TASKCELL_HUB_PUBLIC_URL=https://<name>.trycloudflare.com taskcell hub --repo /path/to/repo --allowed-host <name>.trycloudflare.com --token-file ~/.taskcell/hub-token
```

The name changes every time the quick tunnel starts; update both values.

Put **Cloudflare Access** in front of the hostname: the tunnel makes the hub publicly reachable, and the token is the only other gate. If Access challenges the phone, add a service token policy for the app.

## Run with flow…

A failed hub-board card in the item sheet offers **Run with flow…** next to **Re-run** (hidden when the hub says you may not start tasks). It lists the repository's flows (built-ins and valid repo flows); picking one retries the card with `hub_task_retry` and `flow`. An unknown flow is refused by the hub with the valid names. See [hub.md](hub.md).
