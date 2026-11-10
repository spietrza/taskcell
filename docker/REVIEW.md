Image review evidence

The supplied checkout has one baseline commit, no review diff, no remote, and no PR body.
Docker is unavailable in the review environment. Before/after image sizes, installed
package sizes, cross-platform binary contents, and actual cache reuse remain unverified.
Do not treat these acceptance criteria as complete.

Dockerfile RUN order (eight instructions, with Cursor optional): OS dependencies,
pnpm, bun, Codex, Linear, Cursor, agent user setup, Claude. Version arguments are
scoped beside their installs. Claude is the final filesystem-changing instruction.

Before merging, build the baseline and revised images on the same platform. Record
`docker image inspect --format '{{.Size}}' IMAGE` for both and copy the revised
build.sh package-size output into the PR body. Inspect large packages before pruning
any binaries. Rebuild with only CLAUDE_CLI_VERSION changed and record the cached
steps and image layer count/order in the PR body. build.sh checks that neither
/root/.npm nor /home/agent/.npm exists in the resulting image.
