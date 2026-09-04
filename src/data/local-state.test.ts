import { beforeEach, describe, expect, it } from "vitest";
import { bumpDataRevision, clearMemoryStateForTests, getSettings, saveSettings } from "./local-state";

describe("data revision", () => {
  beforeEach(() => clearMemoryStateForTests());

  it("never collides across consecutive committed updates", async () => {
    const first = await bumpDataRevision();
    const second = await bumpDataRevision();
    expect(first).not.toBe(second);
  });

  it("serializes partial settings merges so concurrent fields cannot overwrite each other", async () => {
    await Promise.all([
      saveSettings({ scheduledSyncEnabled: false }),
      saveSettings({ showPixivChips: false }),
      saveSettings({ syncIntervalHours: 0.5 }),
    ]);
    expect(await getSettings()).toMatchObject({
      scheduledSyncEnabled: false,
      showPixivChips: false,
      syncIntervalHours: 0.5,
    });
  });
});
