# Reach a Mac hub from your phone (no VPS)

The hub runs on your Mac; the phone app (`apps/mobile`) connects to its URL. Two ways to reach it from outside your home network. Either way:

- **The hub token is still required** (the Connect screen asks for it; `taskcell hub` prints it). A hub bound beyond loopback is in server mode and also requires sign-in. A hub on `127.0.0.1` behind `tailscale serve` or a tunnel is public to everyone who reaches that name, so those recipes set `TASKCELL_HUB_SERVER_MODE=1` (sign-in required) and `TASKCELL_HUB_PUBLIC_URL`; never omit them. See [hub.md](hub.md#server-mode-sign-in). A reachable URL is not access.
- **Standalone iOS builds need HTTPS** (App Transport Security blocks plain `http://`). Expo Go allows HTTP, so `http://` works for development only.
- The hub checks `Host` and requires a matching `Origin` on mutating calls. A hostname (not an IP) must be listed with `--allowed-host`; the app sends the hub's own origin, so no other change is needed. See [hub.md](hub.md).

## Tailscale

Install Tailscale on the Mac and the phone, same tailnet.

```sh
tailscale ip -4                      # e.g. 100.64.0.5
tailscale status                     # shows <mac>.<tailnet>.ts.net
taskcell hub --repo /path/to/repo --host 100.64.0.5 --allowed-host <mac>.<tailnet>.ts.net:7777
```

Connect URL: `http://<mac>.<tailnet>.ts.net:7777` (Expo Go only). The Tailscale IP itself needs no `--allowed-host`.

For HTTPS (required for standalone builds), enable HTTPS certificates in the Tailscale admin console, keep the hub on loopback and let Tailscale serve it:

```sh
TASKCELL_HUB_SERVER_MODE=1 TASKCELL_HUB_PUBLIC_URL=https://<mac>.<tailnet>.ts.net taskcell hub --repo /path/to/repo --allowed-host <mac>.<tailnet>.ts.net
tailscale serve --bg --https=443 http://127.0.0.1:7777
```

Connect URL: `https://<mac>.<tailnet>.ts.net`.

## Cloudflare Tunnel

```sh
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create taskcell
cloudflared tunnel route dns taskcell hub.example.com
TASKCELL_HUB_SERVER_MODE=1 TASKCELL_HUB_PUBLIC_URL=https://hub.example.com taskcell hub --repo /path/to/repo --allowed-host hub.example.com
cloudflared tunnel run --url http://127.0.0.1:7777 taskcell
```

Connect URL: `https://hub.example.com` (HTTPS end to end). For a quick test, `cloudflared tunnel --url http://127.0.0.1:7777` prints a `*.trycloudflare.com` host; pass that as `--allowed-host`.

Put **Cloudflare Access** in front of the hostname: the tunnel makes the hub publicly reachable, and the token is the only other gate. If Access challenges the phone, add a service token policy for the app.
