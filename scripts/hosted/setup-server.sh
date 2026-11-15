#!/usr/bin/env bash
# Sets up one hosted Taskcell hub on a fresh Ubuntu 24.04 server (#1041). Run as root on the server:
#
#   HUB_DOMAIN=acme.taskcell.dev SIGNUP_ALLOW=gitlab:alice GITLAB_CLIENT_ID=… GITLAB_CLIENT_SECRET=… \
#     bash setup-server.sh
#
# Installs Docker, builds the hub image from a Taskcell tag, and starts the hub behind Caddy (automatic
# HTTPS). Point HUB_DOMAIN's DNS at the server first, or Caddy cannot get the certificate. Safe to run
# again: it keeps the secrets and hub state, and rebuilds at TASKCELL_REF.
#
# Daily backup (03:15 UTC): the hub's config and state go to /var/backups/taskcell, 7 days kept. With
# BACKUP_S3_URL (an S3-compatible bucket URL, e.g. Cloudflare R2), BACKUP_S3_KEY, BACKUP_S3_SECRET and
# BACKUP_PASSPHRASE each backup is also uploaded, encrypted with the passphrase. The upload leaves out
# hub-secret, the key of the credential store, so saved model keys never leave the server readable; after
# losing the server they have to be entered again.
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
apt-get install -y -q docker.io docker-compose-v2 git ufw openssl cron curl
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
[ -f "$DIR/hub-secret" ] || openssl rand -base64 32 > "$DIR/hub-secret" # credential store key, kept outside /config
{
  echo "HUB_DOMAIN=$HUB_DOMAIN"
  echo "SIGNUP_ALLOW=$SIGNUP_ALLOW"
  echo "AUTH_SECRET=$(cat "$DIR/auth-secret")"
  echo "HUB_SECRET=$(cat "$DIR/hub-secret")"
  for v in BACKUP_S3_URL BACKUP_S3_KEY BACKUP_S3_SECRET BACKUP_PASSPHRASE; do echo "$v=${!v:-}"; done
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
      TASKCELL_HUB_SECRET: ${HUB_SECRET}
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

cat > "$DIR/backup.sh" <<'EOF'
#!/usr/bin/env bash
# Daily hub backup, written by setup-server.sh. Restore: see docs/deploy.md, Recipe D.
set -euo pipefail
umask 077
cd /opt/taskcell
set -a; . ./.env; set +a
out=/var/backups/taskcell
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"
# A consistent copy of the live sign-in database (users, sessions) instead of the file being written.
docker compose exec -T taskcell-hub node -e "
const fs = require('node:fs'); const { DatabaseSync } = require('node:sqlite');
fs.rmSync('/config/auth.backup.sqlite', { force: true });
if (fs.existsSync('/config/auth.sqlite')) new DatabaseSync('/config/auth.sqlite').exec(\"VACUUM INTO '/config/auth.backup.sqlite'\");"
docker compose run --rm -T --no-deps --entrypoint tar taskcell-hub czf - -C / \
  --exclude=config/auth.sqlite --exclude=config/auth.sqlite-wal --exclude=config/auth.sqlite-shm config state > "$tmp/volumes.tgz"
tar czf "$out/taskcell-$stamp.tgz" -C /opt/taskcell .env auth-secret hub-secret -C "$tmp" volumes.tgz
find "$out" -name 'taskcell-*.tgz' -mtime +6 -delete
if [ -n "${BACKUP_S3_URL:-}" ] && [ -n "${BACKUP_S3_KEY:-}" ] && [ -n "${BACKUP_S3_SECRET:-}" ] && [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  tar czf "$tmp/offsite.tgz" -C "$tmp" volumes.tgz
  BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE \
    -in "$tmp/offsite.tgz" -out "$tmp/offsite.tgz.enc"
  curl -fsS --aws-sigv4 "aws:amz:auto:s3" --user "$BACKUP_S3_KEY:$BACKUP_S3_SECRET" \
    -T "$tmp/offsite.tgz.enc" "${BACKUP_S3_URL%/}/$HUB_DOMAIN/taskcell-$stamp.tgz.enc"
fi
echo "backup $stamp done"
EOF
chmod 700 "$DIR/backup.sh"
echo "15 3 * * * root /opt/taskcell/backup.sh >> /var/log/taskcell-backup.log 2>&1" > /etc/cron.d/taskcell-backup
chmod 644 /etc/cron.d/taskcell-backup

cd "$DIR"
docker compose up -d --build
echo "hub starting at https://$HUB_DOMAIN (sign-in callback: https://$HUB_DOMAIN/api/auth/callback/<github|gitlab|google>)"
