// #repo-rename-migration: GitHub identifies a repository by a stable numeric id, but this schema keys
// almost everything off the full_name STRING (repositories.full_name is itself the primary key, and
// most other tables carry a plain repo_full_name column with no foreign-key cascade). A GitHub repo
// rename webhook carries the SAME installation and the new current full_name, but nothing here
// recognizes it as the same repo -- upsertRepositoryFromGitHub's onConflictDoUpdate keys on full_name,
// so the very next webhook after a rename creates a second, disconnected row instead of updating the
// existing one, silently orphaning every PR/issue/audit-trail row already recorded under the old name.
//
// This module is the fix: renameRepositoryIdentity walks every repo-identity-bearing table and moves
// the old name's rows forward to the new name, so a rename preserves history instead of forking it.
// Idempotent (safe to re-run for a redelivered webhook -- every step only touches rows still under
// oldFullName) and collision-safe (where a unique constraint exists, a row that already exists under
// newFullName -- e.g. from a webhook that slipped in under the new name before this ran -- is folded
// away in favor of the pre-existing oldFullName row, never the reverse, so history is never dropped).
//
// Deliberately narrow in scope: only structural identity columns (the ones that determine which repo a
// row belongs to, or serve as part of a primary/unique key) are touched. Free-text content (titles,
// summaries, audit detail), *_json snapshots, and URL columns are left as an accurate historical record
// of what was true when they were captured -- GitHub's own redirect keeps old html_url values working,
// and rewriting historical text/audit content is not what this fix is for.
//
// One explicit block per table, deliberately not a generic cross-table helper: Drizzle's table/column
// types don't generalize cleanly across tables with different secondary keys, and this codebase's own
// convention (repositories.ts) is explicit per-table queries throughout, not a shared query abstraction.
// New tables extend this function directly, following the same shape.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { auditEvents, issues, pullRequests, repositories, repositorySettings } from "./schema";

function repoParts(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf("/");
  return slash === -1 ? { owner: fullName, name: fullName } : { owner: fullName.slice(0, slash), name: fullName.slice(slash + 1) };
}

/**
 * Renames a repository's identity across every structural repo-identity column this module covers so
 * far. Call this BEFORE the normal upsertRepositoryFromGitHub(env, payload.repository, ...) call that
 * every webhook triggers -- once the anchor `repositories` row is renamed, that upsert correctly UPDATEs
 * it instead of inserting a fresh duplicate. A no-op when oldFullName === newFullName.
 */
export async function renameRepositoryIdentity(env: Env, oldFullName: string, newFullName: string): Promise<void> {
  if (oldFullName === newFullName) return;
  const db = getDb(env.DB);
  const { owner, name } = repoParts(newFullName);

  // repositories (PK: full_name alone) -- fold a stray new-name row first, then rename the anchor row.
  await db.delete(repositories).where(eq(repositories.fullName, newFullName));
  await db
    .update(repositories)
    .set({
      fullName: newFullName,
      owner,
      name,
      htmlUrl: sql`replace(${repositories.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(repositories.fullName, oldFullName));

  // repositorySettings (PK: repo_full_name alone) -- same fold-then-rename shape.
  await db.delete(repositorySettings).where(eq(repositorySettings.repoFullName, newFullName));
  await db.update(repositorySettings).set({ repoFullName: newFullName }).where(eq(repositorySettings.repoFullName, oldFullName));

  // pullRequests: unique (repo_full_name, number) -- fold any new-name row whose number already exists
  // under the old name, favoring the pre-existing (oldFullName) row's history.
  const collidingPullNumbers = (
    await db.select({ number: pullRequests.number }).from(pullRequests).where(eq(pullRequests.repoFullName, oldFullName))
  ).map((row) => row.number);
  if (collidingPullNumbers.length > 0) {
    await db.delete(pullRequests).where(and(eq(pullRequests.repoFullName, newFullName), inArray(pullRequests.number, collidingPullNumbers)));
  }
  await db
    .update(pullRequests)
    .set({
      repoFullName: newFullName,
      id: sql`replace(${pullRequests.id}, ${oldFullName}, ${newFullName})`,
      htmlUrl: sql`replace(${pullRequests.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(pullRequests.repoFullName, oldFullName));

  // issues: same shape as pullRequests -- unique (repo_full_name, number).
  const collidingIssueNumbers = (
    await db.select({ number: issues.number }).from(issues).where(eq(issues.repoFullName, oldFullName))
  ).map((row) => row.number);
  if (collidingIssueNumbers.length > 0) {
    await db.delete(issues).where(and(eq(issues.repoFullName, newFullName), inArray(issues.number, collidingIssueNumbers)));
  }
  await db
    .update(issues)
    .set({
      repoFullName: newFullName,
      id: sql`replace(${issues.id}, ${oldFullName}, ${newFullName})`,
      htmlUrl: sql`replace(${issues.htmlUrl}, ${oldFullName}, ${newFullName})`,
    })
    .where(eq(issues.repoFullName, oldFullName));

  // auditEvents.target_key: an append-only log with no uniqueness on target_key (many rows legitimately
  // share one), so a plain substring rename with no dedupe step is correct and sufficient.
  await db
    .update(auditEvents)
    .set({ targetKey: sql`replace(${auditEvents.targetKey}, ${oldFullName}, ${newFullName})` })
    .where(sql`${auditEvents.targetKey} like ${`%${oldFullName}%`}`);
}
