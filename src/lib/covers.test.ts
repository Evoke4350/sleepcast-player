import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { localCover } from "./covers";
import { BUILTIN_FEEDS } from "./store";
import { CATALOG } from "./catalog";

describe("localCover", () => {
  it("has a file for every built-in show", () => {
    for (const f of BUILTIN_FEEDS) expect(existsSync(`public${localCover({ ...f, builtin: true })}`)).toBe(true);
  });
  it("finds a catalog show by its feed, and nothing for one added by link", () => {
    expect(localCover({ id: "custom-1", url: CATALOG[0].url })).toBe(CATALOG[0].art);
    expect(localCover({ id: "custom-2", url: "https://example.com/feed" })).toBeUndefined();
  });
});
