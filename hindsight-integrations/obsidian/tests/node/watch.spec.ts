/**
 * Watch-mode integration test — drives a REAL chokidar watcher over a real temp
 * vault and asserts that create/modify/delete on disk flow through to the engine.
 * Uses polling + a tight awaitWriteFinish so it is deterministic on CI file-
 * systems. This exercises the external framework (chokidar), not a mock.
 */

import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HindsightClient } from "../../src/client";
import { buildConfig, type CliOptions, watchVault } from "../../src/node/cli";
import { FsVault } from "../../src/node/fs-vault";
import { SyncEngine } from "../../src/sync";

let root: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error("condition not met within timeout");
}

function fakeClient() {
  return {
    retain: vi.fn<HindsightClient["retain"]>(async () => {}),
    deleteDocument: vi.fn<(bank: string, docId: string) => Promise<void>>(async () => {}),
  };
}

function options(): CliOptions {
  return {
    vault: root,
    bank: "b",
    apiUrl: "http://unused",
    include: [],
    exclude: [],
    vaultName: "V",
    prefixDocId: false,
    indexPath: join(root, ".idx.json"),
    watch: true,
    identity: {
      apiOrigin: "http://unused",
      bankId: "b",
      vaultPath: root,
      vaultName: "V",
      prefixDocId: false,
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hs-watch-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("watchVault (real chokidar)", () => {
  it("ingests, updates and deletes as files change on disk; ignores non-markdown", async () => {
    const client = fakeClient();
    const vault = new FsVault(root);
    const opts = { ...options(), retainStrategy: "report-notes" };
    const engine = new SyncEngine(
      client as unknown as HindsightClient,
      vault,
      buildConfig(opts),
      {},
      async () => {},
      () => "T0"
    );

    const watcher = await watchVault(opts, engine, vault, {
      usePolling: true,
      interval: 20,
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 },
    });
    const retained = (body: string, strategy: string) =>
      client.retain.mock.calls.some(
        ([bank, path, content, options]) =>
          bank === opts.bank &&
          path === "live.md" &&
          content === body &&
          options?.strategy === strategy
      );
    try {
      await once(watcher, "ready");

      // Create → ingest.
      await writeFile(join(root, "live.md"), "# Live\nfirst");
      await waitFor(() => retained("# Live\nfirst", "report-notes"));

      // A non-markdown file must be ignored entirely.
      await writeFile(join(root, "notes.txt"), "ignore me");
      await sleep(200);
      expect(client.retain.mock.calls.every((c) => c[1] !== "notes.txt")).toBe(true);

      // Modify → re-ingest the changed body under the vault strategy.
      await writeFile(join(root, "live.md"), "# Live\nsecond, changed");
      await waitFor(() => retained("# Live\nsecond, changed", "report-notes"));

      // An edit to frontmatter alone changes the strategy sent for the same body.
      await writeFile(
        join(root, "live.md"),
        "---\nhindsight_retain_strategy: decisions\n---\n# Live\nsecond, changed"
      );
      await waitFor(() => retained("# Live\nsecond, changed", "decisions"));

      // Delete → prune.
      await rm(join(root, "live.md"));
      await waitFor(() => client.deleteDocument.mock.calls.some((c) => c[1] === "live.md"));
    } finally {
      await watcher.close();
    }
  }, 20000);
});
