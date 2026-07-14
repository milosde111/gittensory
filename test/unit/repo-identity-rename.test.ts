import { describe, expect, it } from "vitest";
import { renameRepositoryIdentity } from "../../src/db/repo-identity-rename";
import {
  getIssue,
  getPullRequest,
  getRepository,
  getRepositorySettings,
  listPullRequests,
  recordAuditEvent,
  upsertIssueFromGitHub,
  upsertPullRequestFromGitHub,
  upsertRepositoryFromGitHub,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const OLD = "owner/gittensory";
const NEW = "owner/loopover";

describe("renameRepositoryIdentity", () => {
  it("is a no-op when oldFullName and newFullName are identical", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 1);
    await renameRepositoryIdentity(env, OLD, OLD);
    const repo = await getRepository(env, OLD);
    expect(repo?.fullName).toBe(OLD);
  });

  it("is a safe no-op when nothing exists yet under the old name", async () => {
    const env = createTestEnv();
    await expect(renameRepositoryIdentity(env, OLD, NEW)).resolves.toBeUndefined();
    expect(await getRepository(env, NEW)).toBeNull();
  });

  describe("repositories", () => {
    it("renames the anchor row's full_name, owner, name, and html_url", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, html_url: `https://github.com/${OLD}`, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getRepository(env, OLD)).toBeNull();
      const renamed = await getRepository(env, NEW);
      expect(renamed).toMatchObject({ fullName: NEW, owner: "owner", name: "loopover", installationId: 42, htmlUrl: `https://github.com/${NEW}` });
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name row (already created by a webhook that slipped in under the new name) rather than colliding, keeping the old row's richer state", async () => {
      const env = createTestEnv();
      await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: OLD, private: false, owner: { login: "owner" } }, 42);
      // Simulate the exact drift this module exists to fix: a webhook already created a fresh row under the
      // new name (installationId set, but none of the old row's accumulated state).
      await upsertRepositoryFromGitHub(env, { name: "loopover", full_name: NEW, private: false, owner: { login: "owner" } }, 42);
      await renameRepositoryIdentity(env, OLD, NEW);
      const renamed = await getRepository(env, NEW);
      expect(renamed?.installationId).toBe(42);
      // Exactly one row survives -- the fold, not a second insert.
      expect(await getRepository(env, OLD)).toBeNull();
    });
  });

  describe("repository_settings", () => {
    // getRepositorySettings always returns a (possibly all-default) RepositorySettings, never null, so
    // these assert on the raw row directly to distinguish "no row" / "renamed row" / "folded row".
    it("renames the settings row's repo_full_name", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "off" });
      await renameRepositoryIdentity(env, OLD, NEW);
      const oldRow = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(OLD).first<{ n: number }>();
      expect(oldRow?.n).toBe(0);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("off");
    });

    it("REGRESSION (#repo-rename-migration): folds away a stray new-name settings row, keeping the pre-existing configured settings", async () => {
      const env = createTestEnv();
      await upsertRepositorySettings(env, { repoFullName: OLD, commentMode: "detected_contributors_only" });
      await upsertRepositorySettings(env, { repoFullName: NEW, commentMode: "off" }); // stray, should be discarded
      await renameRepositoryIdentity(env, OLD, NEW);
      const settings = await getRepositorySettings(env, NEW);
      expect(settings.commentMode).toBe("detected_contributors_only");
      const newRowCount = await env.DB.prepare("select count(*) as n from repository_settings where repo_full_name = ?").bind(NEW).first<{ n: number }>();
      expect(newRowCount?.n).toBe(1); // exactly one surviving row, not two
    });
  });

  describe("pull_requests", () => {
    it("renames repo_full_name, id, and html_url for every PR under the old name", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "PR one", state: "open", html_url: `https://github.com/${OLD}/pull/1`, labels: [] });
      await upsertPullRequestFromGitHub(env, OLD, { number: 2, title: "PR two", state: "closed", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, OLD, 1)).toBeNull();
      const pr1 = await getPullRequest(env, NEW, 1);
      expect(pr1).toMatchObject({ repoFullName: NEW, title: "PR one", htmlUrl: `https://github.com/${NEW}/pull/1` });
      const pr2 = await getPullRequest(env, NEW, 2);
      expect(pr2?.title).toBe("PR two");
    });

    it("REGRESSION (#repo-rename-migration): a colliding PR number under the new name is folded away, preserving the pre-existing PR's history instead of the sparse post-rename duplicate", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 5, title: "Original, full history", state: "open", labels: [], body: "the real one" });
      // The sparse duplicate a webhook could have created under the new name before this migration ran.
      await upsertPullRequestFromGitHub(env, NEW, { number: 5, title: "Fragment", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      const rows = await listPullRequests(env, NEW);
      expect(rows.filter((pr) => pr.number === 5)).toHaveLength(1);
      expect(rows.find((pr) => pr.number === 5)?.title).toBe("Original, full history");
    });

    it("does not disturb a PR that only ever existed under the new name (no matching number under the old name)", async () => {
      const env = createTestEnv();
      await upsertPullRequestFromGitHub(env, OLD, { number: 1, title: "old-name PR", state: "open", labels: [] });
      await upsertPullRequestFromGitHub(env, NEW, { number: 99, title: "genuinely new PR", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getPullRequest(env, NEW, 99)).toMatchObject({ title: "genuinely new PR" });
      expect(await getPullRequest(env, NEW, 1)).toMatchObject({ title: "old-name PR" });
    });
  });

  describe("issues", () => {
    it("renames repo_full_name, id, and html_url for every issue under the old name", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 7, title: "Issue seven", state: "open", html_url: `https://github.com/${OLD}/issues/7`, labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, OLD, 7)).toBeNull();
      expect(await getIssue(env, NEW, 7)).toMatchObject({ repoFullName: NEW, title: "Issue seven", htmlUrl: `https://github.com/${NEW}/issues/7` });
    });

    it("REGRESSION (#repo-rename-migration): a colliding issue number under the new name is folded away, keeping the pre-existing issue", async () => {
      const env = createTestEnv();
      await upsertIssueFromGitHub(env, OLD, { number: 3, title: "Original issue", state: "open", labels: [] });
      await upsertIssueFromGitHub(env, NEW, { number: 3, title: "Fragment issue", state: "open", labels: [] });
      await renameRepositoryIdentity(env, OLD, NEW);
      expect(await getIssue(env, NEW, 3)).toMatchObject({ title: "Original issue" });
    });
  });

  describe("audit_events", () => {
    it("renames every target_key containing the old full name, including composite repo#number keys, leaving unrelated keys untouched", async () => {
      const env = createTestEnv();
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: OLD, outcome: "completed", detail: "repo-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: `${OLD}#42`, outcome: "completed", detail: "pr-level, second event, same target_key" });
      await recordAuditEvent(env, { eventType: "test.event", actor: "loopover", targetKey: "some/other-repo#1", outcome: "completed", detail: "unrelated" });

      await renameRepositoryIdentity(env, OLD, NEW);

      const oldRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(OLD).first<{ n: number }>();
      expect(oldRepoLevel?.n).toBe(0);
      const newRepoLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(NEW).first<{ n: number }>();
      expect(newRepoLevel?.n).toBe(1);
      const newPrLevel = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind(`${NEW}#42`).first<{ n: number }>();
      expect(newPrLevel?.n).toBe(2); // both rows sharing the same target_key survive -- no uniqueness on this column
      const unrelated = await env.DB.prepare("select count(*) as n from audit_events where target_key = ?").bind("some/other-repo#1").first<{ n: number }>();
      expect(unrelated?.n).toBe(1);
    });
  });
});
