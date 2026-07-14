import { describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/job-dispatch";
import { getPullRequest, getRepository, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function seedInstalledRepo(env: Env, fullName: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    action: "created",
    installation: { id: installationId, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
  });
  await upsertRepositoryFromGitHub(env, { name: fullName.split("/")[1]!, full_name: fullName, private: false, owner: { login: "owner" } }, installationId);
}

function renamedWebhookPayload(fromName: string, toFullName: string, installationId: number) {
  return {
    action: "renamed",
    changes: { repository: { name: { from: fromName } } },
    repository: { name: toFullName.split("/")[1]!, full_name: toFullName, private: false, owner: { login: "owner" } },
    installation: { id: installationId, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] },
    sender: { login: "owner", type: "User" },
  };
}

describe("repository renamed webhook", () => {
  it("REGRESSION (#repo-rename-migration): a repository/renamed webhook migrates PR history forward instead of creating a disconnected duplicate repo", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9700);
    await upsertPullRequestFromGitHub(env, "owner/gittensory", { number: 1, title: "Pre-rename PR", state: "open", labels: [] });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-1",
      eventName: "repository",
      payload: renamedWebhookPayload("gittensory", "owner/loopover", 9700) as never,
    });

    expect(await getRepository(env, "owner/gittensory")).toBeNull();
    const renamed = await getRepository(env, "owner/loopover");
    expect(renamed?.installationId).toBe(9700);
    const migratedPr = await getPullRequest(env, "owner/loopover", 1);
    expect(migratedPr?.title).toBe("Pre-rename PR");
  }, 30_000);

  it("records a github_app.repository_renamed audit event with the old and new names", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9701);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-2",
      eventName: "repository",
      payload: renamedWebhookPayload("gittensory", "owner/loopover", 9701) as never,
    });

    const row = await env.DB.prepare("select target_key, detail from audit_events where event_type = 'github_app.repository_renamed'").first<{
      target_key: string;
      detail: string;
    }>();
    expect(row?.target_key).toBe("owner/loopover");
    expect(row?.detail).toContain("owner/gittensory");
    expect(row?.detail).toContain("owner/loopover");
  }, 30_000);

  it("does not migrate anything for a repository webhook with a different action (e.g. created)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9702);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "not-a-rename",
      eventName: "repository",
      payload: { action: "created", repository: { name: "gittensory", full_name: "owner/gittensory", private: false, owner: { login: "owner" } }, installation: { id: 9702, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] } } as never,
    });

    expect(await getRepository(env, "owner/gittensory")).not.toBeNull();
  }, 30_000);

  it("does not crash and does not migrate when the payload is missing the old-name field (a sparse/unexpected renamed payload)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/gittensory", 9703);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await expect(
      processJob(env, {
        type: "github-webhook",
        deliveryId: "rename-missing-from",
        eventName: "repository",
        payload: { action: "renamed", repository: { name: "loopover", full_name: "owner/loopover", private: false, owner: { login: "owner" } }, installation: { id: 9703, account: { login: "owner", id: 1, type: "Organization" }, repository_selection: "selected", permissions: {}, events: [] } } as never,
      }),
    ).resolves.toBeUndefined();

    // No migration happened (nothing to migrate from), but the normal upsert still records the current repo state.
    expect(await getRepository(env, "owner/gittensory")).not.toBeNull();
  }, 30_000);

  it("is a safe no-op when the computed old and new full names are identical (e.g. a case-only GitHub-side rename with nothing to migrate)", async () => {
    const env = createTestEnv();
    await seedInstalledRepo(env, "owner/loopover", 9704);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));

    await processJob(env, {
      type: "github-webhook",
      deliveryId: "rename-same-name",
      eventName: "repository",
      payload: renamedWebhookPayload("loopover", "owner/loopover", 9704) as never,
    });

    const renamed = await getRepository(env, "owner/loopover");
    expect(renamed?.installationId).toBe(9704);
  }, 30_000);
});
