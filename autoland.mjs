// Autoland sweeper: enumerate open PRs in this repo and squash-merge the ones that
// are eligible. DRY-RUN unless AUTOLAND_LIVE === "true". The rules live in lib.mjs.
//
// Eligibility (ALL must hold): has the opt-in label; not a draft; no hold label;
// mergeable == MERGEABLE; every configured required context is green; when a
// verdict workflow is configured, its latest pull_request_target run for the head
// SHA succeeded; no trusted STOP comment after the latest commit.
//
// Reads use GH_TOKEN (the job's GITHUB_TOKEN). The MERGE uses the App token, then
// AUTOLAND_PAT, then GITHUB_TOKEN. Merges made with GITHUB_TOKEN fire no push
// event, so downstream deploys don't run; that rung is announced loudly.

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  parseList, requiredContextsGreen, verdictFromRuns, hasTrustedStop, preflight, resolveMergeToken,
} from "./lib.mjs";

const env = process.env;
const LIVE = env.AUTOLAND_LIVE === "true";
const REPO = env.GITHUB_REPOSITORY;
const REQUIRED = parseList(env.AUTOLAND_REQUIRED_CONTEXTS);
const VERDICT_WORKFLOW = (env.AUTOLAND_VERDICT_WORKFLOW || "").trim();
const LABEL = (env.AUTOLAND_LABEL || "auto-land").trim();
const HOLD_LABELS = parseList(env.AUTOLAND_HOLD_LABELS || "hold,no-auto-land");

const gh = (args, token = env.GH_TOKEN) =>
  execFileSync("gh", args, { encoding: "utf8", env: { ...env, GH_TOKEN: token } });
const ghJson = (args) => JSON.parse(gh(args));
const log = (msg) => console.log(msg);
const summary = (msg) => {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${msg}\n`); } catch { /* best-effort */ }
};

// A sweeper with no required contexts would judge every PR on nothing. Refuse,
// loudly: a red run raises the heartbeat issue, a silent pass would not.
if (REQUIRED.length === 0) {
  log("::error title=autoland::required-contexts is empty. Name the checks that must be green before a PR may land.");
  process.exit(1);
}

const merge = resolveMergeToken({ appToken: env.AUTOLAND_APP_TOKEN, pat: env.AUTOLAND_PAT, githubToken: env.GH_TOKEN });
summary(`### Autoland on \`${REPO}\`\n\nMode: **${LIVE ? "LIVE" : "DRY-RUN"}** · merge token: **${merge.mode}**\n\nRequired: ${REQUIRED.map((c) => `\`${c}\``).join(", ")}${VERDICT_WORKFLOW ? ` · verdict workflow: \`${VERDICT_WORKFLOW}\`` : ""}\n`);
if (merge.degraded) {
  log("::warning title=autoland::No release-bot App token or AUTOLAND_PAT; merging would use GITHUB_TOKEN, which fires NO push event, so deploys would not run for anything landed. Check that the App is installed on this repo and its client id / private key are visible to it.");
  summary("⚠️ **Degraded merge token.** Anything landed on `GITHUB_TOKEN` emits no `push` event, so push-triggered deploys will not run.\n");
}
if (LIVE && !merge.token) {
  log("::warning title=autoland::AUTOLAND_LIVE is true but no merge token was resolved. No-op: nothing landed.");
  process.exit(0);
}
log(`Autoland on ${REPO}: ${LIVE ? "LIVE" : "DRY-RUN"}; merge token: ${merge.mode}`);

let prs;
try {
  prs = ghJson(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json",
    "number,labels,isDraft,mergeable,statusCheckRollup,headRefName,headRefOid"]);
} catch (err) {
  log(`::error title=autoland::Could not list PRs: ${err.message}`);
  process.exit(1);
}

const landed = [];
for (const pr of prs) {
  const tag = `#${pr.number} (${pr.headRefName})`;
  const pre = preflight(pr, { label: LABEL, holdLabels: HOLD_LABELS });
  if (pre) { if (!pre.silent) log(`${tag}: skip, ${pre.why}.`); continue; }

  const checks = requiredContextsGreen(pr.statusCheckRollup, REQUIRED);
  if (!checks.ok) { log(`${tag}: skip, not green yet: ${checks.missing.join(", ")}.`); continue; }

  if (VERDICT_WORKFLOW) {
    let verdict;
    try {
      const data = ghJson(["api", `repos/${REPO}/actions/workflows/${VERDICT_WORKFLOW.split("/").pop()}/runs?event=pull_request_target&head_sha=${pr.headRefOid}&per_page=20`]);
      verdict = verdictFromRuns(data.workflow_runs, pr.headRefOid, VERDICT_WORKFLOW);
    } catch (err) {
      verdict = { ok: false, why: `could not read verdict runs: ${err.message}` };
    }
    if (!verdict.ok) { log(`${tag}: skip, review verdict not trusted (${verdict.why}).`); continue; }
  }

  let stop = true;
  try {
    const d = ghJson(["pr", "view", String(pr.number), "--repo", REPO, "--json", "comments,commits"]);
    stop = hasTrustedStop(d.comments, d.commits);
  } catch (err) {
    log(`${tag}: could not read comments (${err.message}); treating as STOP.`);
  }
  if (stop) { log(`${tag}: skip, trusted STOP comment after the latest commit.`); continue; }

  if (!LIVE) { log(`${tag}: ELIGIBLE, would land (dry-run; AUTOLAND_LIVE is not "true").`); summary(`- would land #${pr.number}`); continue; }

  try {
    // --match-head-commit: a push between the rollup read and the merge makes
    // GitHub refuse, instead of landing an unchecked commit.
    gh(["pr", "merge", String(pr.number), "--repo", REPO, "--squash", "--delete-branch", "--match-head-commit", pr.headRefOid], merge.token);
    try { gh(["pr", "comment", String(pr.number), "--repo", REPO, "--body", "auto-landed: required checks green."]); } catch { /* best-effort */ }
    log(`${tag}: LANDED (squash, branch deleted).`);
    summary(`- landed #${pr.number}`);
    landed.push(pr.number);
  } catch (err) {
    log(`${tag}: merge FAILED, ${err.message}`);
  }
}

log(`Sweep done. ${LIVE ? `Landed ${landed.length} PR(s).` : "Dry-run: nothing merged."}`);
if (LIVE && landed.length && merge.degraded) {
  const list = landed.map((n) => `#${n}`).join(", ");
  log(`::warning title=autoland::Landed ${list} on GITHUB_TOKEN. No push event fired, so push-triggered deploys did NOT run for these merges.`);
  summary(`⚠️ **Landed ${list} on the degraded token: push-triggered deploys did not run.** Restore the App token and re-run the deploy.`);
}
