import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseList, requiredContextsGreen, verdictFromRuns, hasTrustedStop, preflight, resolveMergeToken,
} from "../lib.mjs";

const run = (name, conclusion = "SUCCESS", status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context, state = "SUCCESS") => ({ context, state });

test("parseList splits on newlines and commas and drops blanks", () => {
  assert.deepEqual(parseList("a\n b ,c\n\n"), ["a", "b", "c"]);
  assert.deepEqual(parseList(""), []);
});

test("required contexts: all green passes", () => {
  assert.equal(requiredContextsGreen([run("CI"), ctx("review/clear")], ["CI", "review/clear"]).ok, true);
});

test("required contexts: a missing context is not a pass", () => {
  const r = requiredContextsGreen([run("CI")], ["CI", "review/clear"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ["review/clear"]);
});

test("required contexts: failing, in-progress and pending all block", () => {
  assert.equal(requiredContextsGreen([run("CI", "FAILURE")], ["CI"]).ok, false);
  assert.equal(requiredContextsGreen([run("CI", null, "IN_PROGRESS")], ["CI"]).ok, false);
  assert.equal(requiredContextsGreen([ctx("CI", "PENDING")], ["CI"]).ok, false);
});

test("required contexts: NEUTRAL counts as success, unrelated failures are ignored", () => {
  assert.equal(requiredContextsGreen([run("CI", "NEUTRAL"), run("Lighthouse (advisory)", "FAILURE")], ["CI"]).ok, true);
});

test("required contexts: an empty requirement list never passes (fail closed)", () => {
  assert.equal(requiredContextsGreen([run("CI")], []).ok, false);
});

const vrun = (over) => ({ id: 1, path: ".github/workflows/review-verdict.yml", head_sha: "abc", event: "pull_request_target",
  status: "completed", conclusion: "success", created_at: "2026-09-24T10:00:00Z", ...over });

test("verdict: the latest matching pull_request_target run must have succeeded", () => {
  const W = ".github/workflows/review-verdict.yml";
  assert.equal(verdictFromRuns([vrun()], "abc", W).ok, true);
  assert.equal(verdictFromRuns([vrun({ conclusion: "failure" })], "abc", W).ok, false);
  assert.equal(verdictFromRuns([vrun({ status: "in_progress" })], "abc", W).ok, false);
  assert.equal(verdictFromRuns([], "abc", W).ok, false);
});

test("verdict: runs from other events, heads or workflows don't count", () => {
  const W = ".github/workflows/review-verdict.yml";
  assert.equal(verdictFromRuns([vrun({ event: "pull_request" })], "abc", W).ok, false);
  assert.equal(verdictFromRuns([vrun({ head_sha: "zzz" })], "abc", W).ok, false);
  assert.equal(verdictFromRuns([vrun({ path: ".github/workflows/other.yml" })], "abc", W).ok, false);
});

test("verdict: the newest run wins over an older success", () => {
  const W = ".github/workflows/review-verdict.yml";
  const runs = [vrun({ id: 1 }), vrun({ id: 2, conclusion: "failure", created_at: "2026-09-24T11:00:00Z" })];
  assert.equal(verdictFromRuns(runs, "abc", W).ok, false);
});

const commit = { committedDate: "2026-09-24T10:00:00Z" };
test("STOP: a trusted STOP after the latest commit halts", () => {
  assert.equal(hasTrustedStop([{ body: "STOP", authorAssociation: "MEMBER", createdAt: "2026-09-24T10:05:00Z" }], [commit]), true);
});

test("STOP: untrusted authors, older comments and non-STOP words don't halt", () => {
  assert.equal(hasTrustedStop([{ body: "STOP", authorAssociation: "NONE", createdAt: "2026-09-24T10:05:00Z" }], [commit]), false);
  assert.equal(hasTrustedStop([{ body: "STOP", authorAssociation: "OWNER", createdAt: "2026-09-24T09:00:00Z" }], [commit]), false);
  assert.equal(hasTrustedStop([{ body: "unstoppable", authorAssociation: "OWNER", createdAt: "2026-09-24T10:05:00Z" }], [commit]), false);
});

const opts = { label: "auto-land", holdLabels: ["hold", "no-auto-land"] };
const pr = (over) => ({ labels: [{ name: "auto-land" }], isDraft: false, mergeable: "MERGEABLE", ...over });
test("preflight: only labelled, non-draft, unheld, mergeable PRs pass", () => {
  assert.equal(preflight(pr(), opts), null);
  assert.deepEqual(preflight(pr({ labels: [] }), opts), { skip: true, silent: true });
  assert.equal(preflight(pr({ isDraft: true }), opts).skip, true);
  assert.equal(preflight(pr({ labels: [{ name: "auto-land" }, { name: "hold" }] }), opts).skip, true);
  assert.equal(preflight(pr({ mergeable: "CONFLICTING" }), opts).skip, true);
});

test("merge token: App, then PAT, then a degraded GITHUB_TOKEN", () => {
  assert.equal(resolveMergeToken({ appToken: "a", pat: "p", githubToken: "g" }).mode, "release-bot App");
  assert.equal(resolveMergeToken({ appToken: "", pat: "p", githubToken: "g" }).mode, "AUTOLAND_PAT");
  const g = resolveMergeToken({ appToken: "", pat: "", githubToken: "g" });
  assert.equal(g.degraded, true);
  assert.equal(g.token, "g");
});
