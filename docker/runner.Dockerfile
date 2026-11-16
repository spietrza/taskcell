# Template: the Taskcell CONTROLLER image. It runs `taskcell watch` and starts sibling sandbox
# containers via the host docker socket (docker-out-of-docker). This is NOT the sandbox image
# (that is docker/Dockerfile -> taskcell-sandbox). Validate on your host/arch before relying on it.
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
# Bump: `docker buildx imagetools inspect node:24-bookworm-slim` and copy the index Digest.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

# docker CLI (control sibling sandboxes), git, gh (GitHub source + PRs), glab (GitLab source + MRs),
# xz (linear-cli install). glab: same pinned release and checksums as docker/hub.Dockerfile.
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

# Exact versions (bump: `npm view <pkg> version`); keep in sync with docker/Dockerfile (dockerfile-pins.test.ts).
# pnpm stays on 10.x: pnpm 12 rejects the root pnpm-lock.yaml under --frozen-lockfile ("overrides" mismatch).
ARG PNPM_VERSION=10.32.1
ARG LINEAR_CLI_VERSION=3.1.0
RUN npm install -g pnpm@${PNPM_VERSION} @schpet/linear-cli@${LINEAR_CLI_VERSION}

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# Assemble the skills the factory injects into every sandbox: linear-cli (read Linear) + this repo's
# code-review and simplify skills (so the review/simplify stages are skill-driven out of the box).
# The skill is pinned to a commit (tag v3.1.0, matching the sandbox's LINEAR_CLI_VERSION), not HEAD.
# Bump: `git ls-remote https://github.com/schpet/linear-cli refs/tags/vX.Y.Z` and copy the sha.
ARG LINEAR_CLI_SKILL_SHA=02571d34be662e5487204841fb80bf23ed79b4f0
RUN git init -q /opt/linear-cli \
 && git -C /opt/linear-cli fetch -q --depth 1 https://github.com/schpet/linear-cli "${LINEAR_CLI_SKILL_SHA}" \
 && git -C /opt/linear-cli checkout -q FETCH_HEAD \
 && mkdir -p /opt/skills \
 && cp -r /opt/linear-cli/skills/. /opt/skills/ \
 && cp -r /app/skills/. /opt/skills/
ENV SKILLS_DIR=/opt/skills

ENTRYPOINT ["node", "dist/cli/index.js"]
