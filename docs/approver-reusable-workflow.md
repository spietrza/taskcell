# Reusable approver workflow (to be added by a maintainer)

The factory cannot write `.github/workflows/` (CLAUDE.md hard constraint), so the reusable body is kept here. A maintainer
adds it as `.github/workflows/approver.yml`, then replaces the body of `.github/workflows/taskcell-approver.yml` with the caller
from `templates/github/approver.yml` using `uses: ./.github/workflows/approver.yml` and `mode: shadow`. Adopters call it as
`spietrza/taskcell/.github/workflows/approver.yml@v1` once a release tag contains it. Keep the `if:` gate in the caller.

```yaml
name: Taskcell Approver (reusable)

on:
  workflow_call:
    inputs:
      mode: { type: string, default: shadow, description: "shadow (neutral check) or enforce (success/failure); never act here" }
      pr: { type: string, default: "", description: "PR number (workflow_dispatch)" }
      run-pr: { type: string, default: "", description: "PR number from the workflow_run event" }
      head-branch: { type: string, default: "", description: "Head branch from the workflow_run event" }

permissions: {}

jobs:
  approve:
    permissions:
      contents: write
      checks: write
      pull-requests: write
      issues: write
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      group: taskcell-approver-${{ inputs.head-branch || inputs.pr }}
      cancel-in-progress: false
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
        with:
          fetch-depth: 0

      - name: Resolve the PR
        id: pr
        env:
          IN_PR: ${{ inputs.pr }}
          RUN_PR: ${{ inputs.run-pr }}
          HEAD_BRANCH: ${{ inputs.head-branch }}
          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}
        run: |
          pr="${IN_PR:-$RUN_PR}"
          if [ -z "$pr" ] && [ -n "$HEAD_BRANCH" ]; then
            pr=$(gh pr list --repo "$GITHUB_REPOSITORY" --head "$HEAD_BRANCH" --state open --json number --jq '.[0].number // empty')
          fi
          if ! [[ "$pr" =~ ^[1-9][0-9]*$ ]]; then
            echo "No open PR for this run; nothing to decide."
            exit 0
          fi
          base=$(gh pr view "$pr" --repo "$GITHUB_REPOSITORY" --json baseRefName --jq .baseRefName)
          if [ "$base" != "$DEFAULT_BRANCH" ]; then
            echo "PR #$pr targets '$base', not '$DEFAULT_BRANCH'; nothing to decide."
            exit 0
          fi
          echo "number=$pr" >> "$GITHUB_OUTPUT"

      - name: Wait for the required checks
        if: steps.pr.outputs.number != ''
        env:
          PR: ${{ steps.pr.outputs.number }}
        run: gh pr checks "$PR" --repo "$GITHUB_REPOSITORY" --required --watch --interval 30 || true

      - uses: pnpm/action-setup@73e46992e05b19abd31f2f3c20e0e7370d762115 # v6.1.1
        if: steps.pr.outputs.number != ''

      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v6
        if: steps.pr.outputs.number != ''
        with:
          node-version: 24
          cache: pnpm

      - if: steps.pr.outputs.number != ''
        run: pnpm install --frozen-lockfile --ignore-scripts && pnpm build

      - name: Decide
        if: steps.pr.outputs.number != ''
        env:
          PR: ${{ steps.pr.outputs.number }}
          MODE: ${{ inputs.mode == 'enforce' && 'enforce' || 'shadow' }}
          TASKCELL_APPROVER_STOP: ${{ vars.TASKCELL_APPROVER_STOP || vars.VANGUARD_APPROVER_STOP }}
        run: node dist/cli/index.js approve --pr "$PR" --github-repo "$GITHUB_REPOSITORY" --mode "$MODE"
```

For another repo the build step must fetch the taskcell CLI (as `pr-review.yml` does with `.vanguard-src`) instead of building the
checked-out repo; adjust when adding the file.
