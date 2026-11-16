# The Taskcell HUB image. Serves the desktop Inspector UI (apps/desktop) over plain HTTP/SSE via
# `taskcell hub` (src/hub/*.ts, src/cli/hub.ts) for local/VPS use without Tauri. Runs agent sandboxes
# via the host docker socket (docker-out-of-docker), same as docker/runner.Dockerfile.
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
# Bump: `docker buildx imagetools inspect node:24-bookworm-slim` and copy the index Digest.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# docker CLI (sibling-sandbox execution), git, gh/glab (remote factory operations), xz (linear-cli install).
ARG GLAB_VERSION=1.50.0
ARG GLAB_SHA256_AMD64=15bd7b19ea416091dae4adc6578ef39df88020044136c0de23fc2315d3b0e9ee
ARG GLAB_SHA256_ARM64=0caa82900bb0719a6dfe8f40a4060a02b68ed88ba689e7b0a4c811f91ed16f5a
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg xz-utils docker.io \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) glab_sha="$GLAB_SHA256_AMD64" ;; arm64) glab_sha="$GLAB_SHA256_ARM64" ;; *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${arch}.deb" -o /tmp/glab.deb \
 && echo "$glab_sha  /tmp/glab.deb" | sha256sum -c - \
 && dpkg -i /tmp/glab.deb \
 && rm /tmp/glab.deb \
 && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=10.32.1
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build \
 && pnpm --dir apps/desktop install --frozen-lockfile && pnpm --dir apps/desktop build

# Image defaults stay under the old names on purpose: the hub reads TASKCELL_HUB_* first, so a default baked
# under the new name would silently beat a VANGUARD_HUB_* value in an existing compose file.
ENV VANGUARD_HUB_HOST=0.0.0.0 \
    VANGUARD_HUB_PORT=7777 \
    VANGUARD_HUB_UI_DIR=/app/apps/desktop/dist \
    VANGUARD_HUB_CONFIG_DIR=/config

EXPOSE 7777

HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:7777/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "dist/cli/index.js", "hub", "--no-open"]
