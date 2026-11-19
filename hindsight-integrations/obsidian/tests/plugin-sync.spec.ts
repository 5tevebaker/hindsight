import type { App, PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HindsightPlugin from "../src/main";
import { requestUrl } from "./__mocks__/obsidian";

async function setupVault(content: string, strategy: string): Promise<HindsightPlugin> {
  const file = { path: "notes.md", stat: { ctime: 1, mtime: 1 } };
  const app = {
    vault: {
      getName: () => "Team",
      getMarkdownFiles: () => [file],
      read: async () => content,
    },
    workspace: { getLeavesOfType: () => [] },
  } as unknown as App;
  const plugin = new HindsightPlugin(app, {} as PluginManifest);
  Object.assign(plugin, { app, saveData: vi.fn() });
  plugin.settings.retainStrategy = strategy;
  await plugin.saveSettings();
  return plugin;
}

describe("plugin vault sync", () => {
  beforeEach(() => {
    requestUrl.mockClear();
  });

  it("sends the vault strategy for a note without an override", async () => {
    const plugin = await setupVault("Report", "report-notes");
    await plugin.syncVault();
    expect(JSON.parse(requestUrl.mock.calls[0][0].body!).items[0].strategy).toBe("report-notes");
  });

  it("sends the note override as the strategy and preserves only note metadata", async () => {
    const plugin = await setupVault(
      "---\nhindsight_retain_strategy: incident-report\nstatus: draft\n---\nReport",
      "journal"
    );
    await plugin.syncVault();
    const item = JSON.parse(requestUrl.mock.calls[0][0].body!).items[0];
    expect(item.strategy).toBe("incident-report");
    expect(item.metadata).toEqual({ status: "draft", vault: "Team", path: "notes.md" });
  });

  it("skips an already-synced note when only the vault setting changes", async () => {
    const plugin = await setupVault("Report", "journal");
    await plugin.syncVault();
    plugin.settings.retainStrategy = "report-notes";
    await plugin.saveSettings();
    await plugin.syncVault();
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("omits strategy when both note and vault settings are blank", async () => {
    const plugin = await setupVault("---\nhindsight_retain_strategy: ''\n---\nReport", "  ");
    await plugin.syncVault();
    expect(JSON.parse(requestUrl.mock.calls[0][0].body!).items[0]).not.toHaveProperty("strategy");
  });
});
