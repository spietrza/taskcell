# Vanguard sandbox image: node + git + the claude, codex and (normally) linear CLIs, non-root user.
# Single stage so the global npm bins and their node_modules stay consistent (the linear-cli
# launcher resolves a sibling binary, which breaks when bins are copied across build stages).
# Pinned by digest for a reproducible, tamper-evident base (the tag is kept for readability).
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
# Exact CLI versions, never `latest`, so a rebuild cannot silently pull a new (or hijacked) release.
# Bump: `npm view <pkg> version`, update the default here (or pass --build-arg), rebuild, run build.sh.

# xz-utils + ca-certificates: the linear-cli npm package downloads and untars an .xz release binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Shared retry-with-backoff for every release download below (npm installs here, curl for Cursor):
# npm and GitHub Releases return transient 5xx often enough to fail whole factory runs (#657). Removed
# near the end of the build (see the claude install), so it never lands in the final image.
COPY retry.sh /tmp/retry.sh
RUN chmod +x /tmp/retry.sh

# claude/codex run the agent (selectable via --provider/--review-provider); linear lets the agent use
# the linear-cli skill; pnpm and bun let it install deps and run the project's typecheck/tests from
# inside the sandbox before finishing. bun is required for bun-workspace monorepos (e.g. ModelBox),
# whose `bun install` / `bun run *` scripts pnpm cannot drive — without it the agent cannot build or
# verify and ends up confabulating completion. Codex authenticates with CODEX_API_KEY: in direct mode
# it is forwarded into the sandbox when codex is selected; under --llm-proxy the key is held by a
# trusted sidecar and the sandbox receives only a per-run nonce.
ARG PNPM_VERSION=12.18.0
RUN /tmp/retry.sh 5 15 -- npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force && rm -rf /root/.npm

ARG BUN_VERSION=1.4.4
RUN /tmp/retry.sh 5 15 -- npm install -g bun@${BUN_VERSION} && npm cache clean --force && rm -rf /root/.npm

ARG CODEX_CLI_VERSION=0.167.0
RUN /tmp/retry.sh 5 15 -- npm install -g @openai/codex@${CODEX_CLI_VERSION} && npm cache clean --force && rm -rf /root/.npm

# linear-cli's postinstall downloads its binary from GitHub Releases, which can return 5xx for long
# stretches (#657). Only `--linear` runs need it, so when every attempt failed on that download (and
# only then) the image is built without it; `doctor` and run preflight report it for a `--linear` run.
# An integrity or missing-version error on any attempt still fails the build. LINEAR_RETRY changes the layer's
# cache key, so `LINEAR_RETRY=1 docker/build.sh` retries a cached build that skipped it.
ARG LINEAR_CLI_VERSION=3.1.0
ARG LINEAR_RETRY=
RUN echo "linear-retry=${LINEAR_RETRY}" >/dev/null; : >/tmp/linear-install.log; \
    for i in 1 2 3 4 5; do \
      npm install -g @schpet/linear-cli@${LINEAR_CLI_VERSION} >/tmp/linear-attempt.log 2>&1 \
        && linear --version >/dev/null && npm cache clean --force && rm -rf /root/.npm \
        && rm -f /tmp/linear-*.log && exit 0; \
      cat /tmp/linear-attempt.log >&2; cat /tmp/linear-attempt.log >>/tmp/linear-install.log; \
      [ "$i" -lt 5 ] || break; \
      echo "linear-cli install failed (attempt $i/5), retrying in $((i * 15))s" >&2; sleep $((i * 15)); \
    done; \
    if grep -qE 'EINTEGRITY|E404|ETARGET|Integrity check failed' /tmp/linear-install.log; then exit 1; fi; \
    grep -qE 'Error fetching release: Request failed with status code 5[0-9][0-9]' /tmp/linear-install.log || exit 1; \
    rm -f /tmp/linear-*.log; \
    npm uninstall -g @schpet/linear-cli >&2 || true; \
    rm -f "$(npm prefix -g)/bin/linear"; \
    if command -v linear >/dev/null; then echo "linear still on PATH after uninstall" >&2; exit 1; fi; \
    npm cache clean --force && rm -rf /root/.npm || exit 1; \
    echo "WARNING: GitHub Releases unavailable; image built WITHOUT linear-cli (--linear runs will fail preflight)" >&2

# Cursor CLI (`agent`, --provider cursor) is opt-in: ~550 MB unpacked, so it is installed only when a
# version is given, e.g. CURSOR_CLI_VERSION=2026.10.16-e3cb207 (the id cursor.com/install pins).
# Declared here, not at the top, so setting it leaves the layers above cached.
# Cursor publishes no checksums, so the tarball is verified against a per-arch sha256 pinned here. The
# defaults are for 2026.10.16-e3cb207; another version must pass its own CURSOR_CLI_SHA256_X64/_ARM64.
# Bump: download linux/{x64,arm64}/agent-cli-package.tar.gz for the new id once, `sha256sum` each.
ARG CURSOR_CLI_VERSION=
ARG CURSOR_CLI_SHA256_X64=3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552
ARG CURSOR_CLI_SHA256_ARM64=4cf077f150eb8d1e270bf1dea69700184c39a4847fe192d523f5bb34d4b62597
# Root-owned under /opt with the bin on /usr/local/bin: `sh -lc` resets PATH from /etc/profile, so the
# installer's ~/.local/bin would not be found. curl is pulled in only for this download.
RUN if [ -n "${CURSOR_CLI_VERSION}" ]; then \
      case "$(uname -m)" in \
        x86_64) arch=x64; sha="${CURSOR_CLI_SHA256_X64}" ;; \
        aarch64|arm64) arch=arm64; sha="${CURSOR_CLI_SHA256_ARM64}" ;; \
        *) echo "cursor: unsupported arch $(uname -m)" >&2; exit 1 ;; \
      esac \
      && apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
      && /tmp/retry.sh 5 15 -- curl -fsSL -o /tmp/cursor-agent.tar.gz \
         "https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/linux/${arch}/agent-cli-package.tar.gz" \
      && echo "${sha}  /tmp/cursor-agent.tar.gz" | sha256sum -c - \
      && mkdir -p /opt/cursor-agent \
      && tar --strip-components=1 -xzf /tmp/cursor-agent.tar.gz -C /opt/cursor-agent \
      && rm /tmp/cursor-agent.tar.gz \
      && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/agent \
      && agent --version; \
    fi

RUN groupadd -g 10001 agent \
 && useradd -m -u 10001 -g agent -s /bin/bash agent \
 && mkdir -p /workspace /home/agent/.claude \
 && chown -R agent:agent /workspace /home/agent

# Most frequently bumped CLI goes last; scope its ARG to this layer.
ARG CLAUDE_CLI_VERSION=2.1.260
RUN /tmp/retry.sh 5 15 -- npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} && npm cache clean --force && rm -rf /root/.npm

# Last use of the retry helper: drop it so it never lands in the final image.
RUN rm -f /tmp/retry.sh

USER agent
WORKDIR /workspace
ENV HOME=/home/agent
CMD ["sleep", "infinity"]
