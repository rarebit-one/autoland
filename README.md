# autoland

A GitHub Action that squash-merges pull requests carrying an opt-in label once
their required checks are green. It runs as a sweeper: each run looks at every
open PR in the repo and lands the eligible ones. **It is a dry run unless you
arm it**, so it can be installed safely and watched before it merges anything.

Ported from `rarebit-one/rarebit-static-v3`'s gated auto-land, with the
repo-specific parts made inputs.

## When a PR lands

All of these must hold:

- it carries the opt-in label (`auto-land` by default) and none of the hold labels (`hold`, `no-auto-land`);
- it is not a draft, and GitHub reports it `MERGEABLE`;
- **every** context in `required-contexts` is present and green. A check that never ran counts as missing, not passing;
- if `verdict-workflow` is set, that workflow's latest `pull_request_target` run for the PR's head commit succeeded. A plain commit status can be posted by any workflow token, but `pull_request_target` runs come from the base branch, so PR code can't forge them;
- no repo owner, member or collaborator has commented `STOP` since the latest commit.

The merge is pinned to the head commit it checked (`--match-head-commit`), so a
push that arrives mid-sweep makes GitHub refuse the merge instead of landing an
unchecked commit.

## Which token merges

A merge made with the built-in `GITHUB_TOKEN` fires no `push` event, so
push-triggered deploys silently never run. The action therefore merges with,
in order:

1. `app-token`: a GitHub App installation token (recommended; it doesn't expire);
2. `pat`: a personal access token;
3. `github-token`: last resort. The run warns loudly and names what won't deploy.

## Usage

```yaml
name: autoland
on:
  workflow_run:
    workflows: [CI]            # the workflows that produce your required checks
    types: [completed]
  pull_request_review:
    types: [submitted]
  pull_request_target:
    types: [labeled]
  schedule:
    - cron: "23 */6 * * *"     # safety net
  workflow_dispatch:
permissions:
  contents: read
  pull-requests: write
  checks: read
  statuses: read
  actions: read
concurrency:
  group: autoland
  cancel-in-progress: false
jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - id: app
        continue-on-error: true    # a missing App falls through to the next rung
        uses: actions/create-github-app-token@<sha> # v3
        with:
          client-id: ${{ vars.RELEASE_BOT_CLIENT_ID }}
          private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
      - uses: rarebit-one/autoland@<sha> # v1.0.0
        with:
          required-contexts: |
            CI
            review / Claude Code Review
          live: ${{ vars.AUTOLAND_LIVE == 'true' }}
          app-token: ${{ steps.app.outputs.token }}
```

The workflow doesn't check out the PR, so running it on `pull_request_target`
executes no PR code.

**Arm it** per repo, once the dry-run log shows it picks the right PRs:
`gh variable set AUTOLAND_LIVE --body true`. Disarm by deleting the variable.

## Develop

```bash
node --test tests/*.test.mjs
```

CI runs the unit tests, a negative control (an empty `required-contexts` must
fail the action), and a dry-run sweep of this repo.

Release: `git tag -s v1.x.y` and move the `v1` tag. Callers pin a full SHA.
