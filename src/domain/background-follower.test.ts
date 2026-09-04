import { describe, expect, it, vi } from "vitest";
import {
  collectFollowerForRun,
  type FollowerCollectionDependencies,
} from "../../entrypoints/background";
import { PixivApiError } from "./pixiv-api";

const account = {
  id: "123456",
  name: "Author",
  profileUrl: "https://www.pixiv.net/users/123456",
};

function dependencies(overrides: Partial<FollowerCollectionDependencies> = {}): FollowerCollectionDependencies {
  return {
    getTrustedStagedAccount: vi.fn(async () => account),
    reserveAccountFollowerCollection: vi.fn(async () => true),
    collectPixivFollowerCount: vi.fn(async (accountId) => ({
      accountId,
      followers: 834,
      collectedAt: "2026-09-01T09:00:01.000Z",
    })),
    settleAccountFollowerCollection: vi.fn(async () => undefined),
    now: () => "2026-09-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("full-run follower collection", () => {
  it("settles a successful result with the reservation timestamp", async () => {
    const deps = dependencies();

    await collectFollowerForRun({ runId: "run-1", accountId: null, fallbackReason: null }, deps);

    expect(deps.getTrustedStagedAccount).toHaveBeenCalledWith("run-1", undefined);
    expect(deps.reserveAccountFollowerCollection).toHaveBeenCalledWith({
      runId: "run-1",
      accountId: account.id,
      collectedAt: "2026-09-01T09:00:00.000Z",
    });
    expect(deps.collectPixivFollowerCount).toHaveBeenCalledWith(account.id);
    expect(deps.settleAccountFollowerCollection).toHaveBeenCalledWith({
      runId: "run-1",
      accountId: account.id,
      collectedAt: "2026-09-01T09:00:00.000Z",
      followers: 834,
      errorCode: null,
    });
  });

  it.each(["RATE_LIMITED", "CHALLENGE", "AUTH_REQUIRED"] as const)(
    "skips network work for a known %s fallback",
    async (fallbackReason) => {
      const deps = dependencies();

      await collectFollowerForRun({ runId: "run-1", accountId: account.id, fallbackReason }, deps);

      expect(deps.getTrustedStagedAccount).not.toHaveBeenCalled();
      expect(deps.reserveAccountFollowerCollection).not.toHaveBeenCalled();
      expect(deps.collectPixivFollowerCount).not.toHaveBeenCalled();
      expect(deps.settleAccountFollowerCollection).not.toHaveBeenCalled();
    },
  );

  it("does not request when another worker already owns the reservation", async () => {
    const deps = dependencies({ reserveAccountFollowerCollection: vi.fn(async () => false) });

    await collectFollowerForRun({ runId: "run-1", accountId: account.id, fallbackReason: null }, deps);

    expect(deps.collectPixivFollowerCount).not.toHaveBeenCalled();
    expect(deps.settleAccountFollowerCollection).not.toHaveBeenCalled();
  });

  it("settles an unavailable result and swallows collector failures", async () => {
    const deps = dependencies({
      collectPixivFollowerCount: vi.fn(async () => {
        throw new PixivApiError("CHALLENGE", "challenge");
      }),
    });

    await expect(collectFollowerForRun({ runId: "run-1", accountId: account.id, fallbackReason: null }, deps)).resolves.toBeUndefined();
    expect(deps.settleAccountFollowerCollection).toHaveBeenCalledWith({
      runId: "run-1",
      accountId: account.id,
      collectedAt: "2026-09-01T09:00:00.000Z",
      followers: null,
      errorCode: "CHALLENGE",
    });
  });

  it("does not reserve when the staged account cannot be trusted", async () => {
    const deps = dependencies({
      getTrustedStagedAccount: vi.fn(async () => {
        throw new Error("staged pages are incomplete");
      }),
    });

    await collectFollowerForRun({ runId: "run-1", accountId: null, fallbackReason: null }, deps);

    expect(deps.reserveAccountFollowerCollection).not.toHaveBeenCalled();
    expect(deps.collectPixivFollowerCount).not.toHaveBeenCalled();
  });
});
