#!/usr/bin/env bash
# Sets up one hosted Taskcell hub on a fresh Ubuntu 24.04 server (#1041). Run as root on the server:
#
#   HUB_DOMAIN=acme.taskcell.dev SIGNUP_ALLOW=gitlab:alice GITLAB_CLIENT_ID=… GITLAB_CLIENT_SECRET=… \
#     bash setup-server.sh
#
# Installs Docker, builds the hub image from a Taskcell tag, and starts the hub behind Caddy (automatic
# HTTPS). Point HUB_DOMAIN's DNS at the server first, or Caddy cannot get the certificate. Safe to run
# again: it keeps the auth secret and hub state, and rebuilds at TASKCELL_REF.
set -euo pipefail

: "${HUB_DOMAIN:?set HUB_DOMAIN, e.g. acme.taskcell.dev}"
: "${SIGNUP_ALLOW:?set SIGNUP_ALLOW (who may create an account, e.g. gitlab:alice or alice@example.com)}"
TASKCELL_REF="${TASKCELL_REF:-main}"    # shortcut: main until 1.16.0 (server-mode sign-in) is tagged, then pin the tag
CLONE_HOSTS="${CLONE_HOSTS:-}"          # extra hosts beyond github.com/gitlab.com (self-managed GitLab)
GITLAB_ISSUER="${GITLAB_ISSUER:-}"      # self-managed GitLab base URL for sign-in
MAX_SANDBOXES="${MAX_SANDBOXES:-1}"     # one run at a time on a 4 GB server
DIR=/opt/taskcell

[[ "$HUB_DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || { echo "HUB_DOMAIN is not a host name: $HUB_DOMAIN" >&2; exit 1; }
if [ -z "${GITHUB_CLIENT_ID:-}${GITLAB_CLIENT_ID:-}${GOOGLE_CLIENT_ID:-}" ]; then
  echo "set at least one sign-in provider: GITHUB_, GITLAB_ or GOOGLE_CLIENT_ID and _CLIENT_SECRET" >&2; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 git ufw openssl
systemctl enable --now docker 2>/dev/null || true # no systemd in a test container

ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null 2>&1 || echo "ufw not enabled (no netfilter here); open only 22, 80 and 443 on this host" >&2

mkdir -p "$DIR" /work
if [ -d "$DIR/src/.git" ]; then
  git -C "$DIR/src" fetch -q --depth 1 origin "$TASKCELL_REF" && git -C "$DIR/src" checkout -q FETCH_HEAD
else
  git clone -q --depth 1 --branch "$TASKCELL_REF" https://github.com/spietrza/taskcell "$DIR/src"
fi

umask 077
[ -f "$DIR/auth-secret" ] || openssl rand -hex 32 > "$DIR/auth-secret"
{
  echo "HUB_DOMAIN=$HUB_DOMAIN"
  echo "SIGNUP_ALLOW=$SIGNUP_ALLOW"
  echo "AUTH_SECRET=$(cat "$DIR/auth-secret")"
  echo "MAX_SANDBOXES=$MAX_SANDBOXES"
  echo "CLONE_HOSTS=$CLONE_HOSTS"
  echo "GITLAB_ISSUER=$GITLAB_ISSUER"
  for p in GITHUB GITLAB GOOGLE; do
    id="${p}_CLIENT_ID" secret="${p}_CLIENT_SECRET"
    echo "${p}_CLIENT_ID=${!id:-}"
    echo "${p}_CLIENT_SECRET=${!secret:-}"
  done
} > "$DIR/.env"
umask 022

cat > "$DIR/Caddyfile" <<'EOF'
{$HUB_DOMAIN} {
	reverse_proxy taskcell-hub:7777
}
EOF

# /work is mounted at the same path inside the hub, so the sandboxes it starts on the host docker see the
# same clone paths (docker-out-of-docker binds host paths).
cat > "$DIR/compose.yaml" <<'EOF'
services:
  taskcell-hub:
    build:
      context: ./src
      dockerfile: docker/hub.Dockerfile
    image: taskcell-hub:local
    restart: unless-stopped
    mem_limit: 1024m
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /work:/work
      - hub-config:/config
      - hub-state:/state
    environment:
      TASKCELL_MAX_SANDBOXES: ${MAX_SANDBOXES}
      TASKCELL_HUB_TOKEN_FILE: /state/hub.key
      TASKCELL_HUB_ALLOWED_HOSTS: ${HUB_DOMAIN}
      TASKCELL_HUB_PUBLIC_URL: https://${HUB_DOMAIN}
      TASKCELL_HUB_AUTH_SECRET: ${AUTH_SECRET}
      TASKCELL_HUB_SIGNUP_ALLOW: ${SIGNUP_ALLOW}
      TASKCELL_HUB_ALLOW_ADD: "1"
      TASKCELL_HUB_CLONE_HOSTS: ${CLONE_HOSTS}
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID}
      TASKCELL_HUB_AUTH_GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET}
      TASKCELL_HUB_AUTH_GITLAB_CLIENT_ID: ${GITLAB_CLIENT_ID}
      TASKCELL_HUB_AUTH_GITLAB_CLIENT_SECRET: ${GITLAB_CLIENT_SECRET}
      TASKCELL_HUB_AUTH_GITLAB_ISSUER: ${GITLAB_ISSUER}
      TASKCELL_HUB_AUTH_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      TASKCELL_HUB_AUTH_GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
  caddy:
    image: caddy:2.10
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    environment:
      HUB_DOMAIN: ${HUB_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  hub-config:
  hub-state:
  caddy-data:
EOF

cd "$DIR"
docker compose up -d --build
echo "hub starting at https://$HUB_DOMAIN (sign-in callback: https://$HUB_DOMAIN/api/auth/callback/<github|gitlab|google>)"
