// Pure eligibility logic for the autoland sweeper. No I/O here, so every rule is
// unit-tested (tests/lib.test.mjs). Ported from rarebit-one/rarebit-static-v3's
// .github/scripts/auto-land.mjs, with the repo-specific parts made inputs.

export const TRUSTED_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Parse a newline- or comma-separated list input; blank entries dropped.
export function parseList(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// statusCheckRollup entries are a union of CheckRun and StatusContext shapes.
// Normalise each to { name, ok } where ok means "succeeded".
export function rollupResult(node) {
  if (node.__typename === "CheckRun" || node.status !== undefined) {
    const conclusion = (node.conclusion || "").toUpperCase();
    return {
      name: node.name,
      ok: node.status === "COMPLETED" && (conclusion === "SUCCESS" || conclusion === "NEUTRAL"),
    };
  }
  return { name: node.context, ok: (node.state || "").toUpperCase() === "SUCCESS" };
}

// Every required context must be present AND green. A context that never ran
// is missing, not passing: an empty rollup never qualifies.
export function requiredContextsGreen(rollup, required) {
  if (!required || required.length === 0) {
    return { ok: false, missing: ["<no required contexts configured>"] };
  }
  const byName = new Map();
  for (const node of rollup || []) {
    const { name, ok } = rollupResult(node);
    if (name) byName.set(name, ok);
  }
  const missing = required.filter((ctx) => byName.get(ctx) !== true);
  return { ok: missing.length === 0, missing };
}

// The trusted verdict: the latest pull_request_target run of the verdict
// workflow for this exact head SHA must have completed successfully. GitHub
// creates those runs from the BASE branch's workflow file, so PR code cannot
// change the verdict; a commit status alone is forgeable by any workflow token.
export function verdictFromRuns(runs, headSha, workflowPath) {
  const matching = (runs || [])
    .filter((r) => r.path === workflowPath && r.head_sha === headSha && r.event === "pull_request_target")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const latest = matching[0];
  if (!latest) return { ok: false, why: "no pull_request_target verdict run for this head" };
  if (latest.status !== "completed") return { ok: false, why: `verdict run ${latest.id} is ${latest.status}` };
  if (latest.conclusion !== "success") return { ok: false, why: `verdict run ${latest.id} concluded ${latest.conclusion}` };
  return { ok: true, why: `verdict run ${latest.id} succeeded` };
}

// A STOP comment from a trusted author at or after the latest commit halts landing.
export function hasTrustedStop(comments, commits) {
  const lastCommitAt = (commits || [])
    .map((c) => new Date(c.committedDate || c.authoredDate || 0).getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  return (comments || []).some((c) => {
    if (!/\bSTOP\b/.test((c.body || "").trim())) return false;
    if (!TRUSTED_ASSOC.has((c.authorAssociation || "").toUpperCase())) return false;
    return new Date(c.createdAt || 0).getTime() >= lastCommitAt;
  });
}

// Cheap gates, checked before any API call. Returns null when the PR passes them,
// otherwise the skip reason (null reason + silent=true for PRs that never opted in).
export function preflight(pr, { label, holdLabels }) {
  const labels = new Set((pr.labels || []).map((l) => l.name));
  if (!labels.has(label)) return { skip: true, silent: true };
  if (pr.isDraft) return { skip: true, why: "draft" };
  const held = holdLabels.find((h) => labels.has(h));
  if (held) return { skip: true, why: `has '${held}' label` };
  if (pr.mergeable !== "MERGEABLE") return { skip: true, why: `mergeable=${pr.mergeable} (needs MERGEABLE)` };
  return null;
}

// Which merge credential to use: App -> PAT -> GITHUB_TOKEN. Only the last fires
// no push event, so it is flagged as degraded.
export function resolveMergeToken({ appToken, pat, githubToken }) {
  if (appToken) return { token: appToken, mode: "release-bot App", degraded: false };
  if (pat) return { token: pat, mode: "AUTOLAND_PAT", degraded: false };
  return { token: githubToken || "", mode: "GITHUB_TOKEN (degraded)", degraded: true };
}
