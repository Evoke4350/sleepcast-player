import { describe, expect, test, vi } from "vitest";
import { createApiLoader, YT_API_SRC } from "./youtube-api";

function host(initial: { YT?: unknown } = {}) {
  const injected: string[] = [];
  const win = { ...initial } as Parameters<typeof createApiLoader>[0];
  const load = createApiLoader(win, (src) => injected.push(src));
  return { win, injected, load };
}

const READY_YT = { Player: function () {} };

describe("when Google's player is already on the page", () => {
  test("resolves without injecting anything", async () => {
    const { injected, load } = host({ YT: READY_YT });
    await expect(load()).resolves.toBeDefined();
    expect(injected).toEqual([]);
  });

  test("hands back the namespace, so callers never touch window themselves", async () => {
    const { load } = host({ YT: READY_YT });
    expect(await load()).toBe(READY_YT);
  });

  test("a YT object without Player is not ready", async () => {
    // The script sets window.YT before it finishes defining Player. Treating
    // the bare object as ready constructs a player from undefined and the
    // night starts in silence.
    const { injected, load } = host({ YT: {} });
    void load();
    expect(injected).toEqual([YT_API_SRC]);
  });
});

describe("loading it for the first time", () => {
  test("injects the API script", () => {
    const { injected, load } = host();
    void load();
    expect(injected).toEqual([YT_API_SRC]);
  });

  test("resolves once YouTube calls its ready hook", async () => {
    const { win, load } = host();
    const pending = load();
    win.YT = READY_YT;
    win.onYouTubeIframeAPIReady!();
    expect(await pending).toBe(READY_YT);
  });

  test("two callers at once share one script and both resolve", async () => {
    const { win, injected, load } = host();
    const a = load();
    const b = load();
    expect(injected).toEqual([YT_API_SRC]);
    win.YT = READY_YT;
    win.onYouTubeIframeAPIReady!();
    expect([await a, await b]).toEqual([READY_YT, READY_YT]);
  });

  test("a later caller gets the loaded namespace without a second script", async () => {
    const { win, injected, load } = host();
    const first = load();
    win.YT = READY_YT;
    win.onYouTubeIframeAPIReady!();
    await first;
    await expect(load()).resolves.toBe(READY_YT);
    expect(injected).toEqual([YT_API_SRC]);
  });

  test("does not trample a ready hook someone else installed", async () => {
    // onYouTubeIframeAPIReady is a single global slot. Overwriting another
    // consumer's handler would break them; being overwritten would hang us.
    const theirs = vi.fn();
    const { win, load } = host();
    win.onYouTubeIframeAPIReady = theirs;
    const pending = load();
    win.YT = READY_YT;
    win.onYouTubeIframeAPIReady!();
    await pending;
    expect(theirs).toHaveBeenCalledTimes(1);
  });
});

describe("when the script never arrives", () => {
  test("rejects rather than leaving the night hanging in silence", async () => {
    // A blocked CDN, an offline phone, a CSP that forbids the origin: without
    // a deadline the promise never settles, the component never renders an
    // error, and the listener watches a black rectangle until morning.
    vi.useFakeTimers();
    try {
      const { load } = host();
      const pending = load(50);
      const settled = expect(pending).rejects.toThrow(/youtube/i);
      await vi.advanceTimersByTimeAsync(51);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed load can be retried", async () => {
    // The rejection must not be cached, or a single flaky night poisons the
    // feature until a full reload.
    vi.useFakeTimers();
    try {
      const { win, injected, load } = host();
      const failed = expect(load(50)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(51);
      await failed;

      const retry = load(50);
      expect(injected).toEqual([YT_API_SRC, YT_API_SRC]);
      win.YT = READY_YT;
      win.onYouTubeIframeAPIReady!();
      expect(await retry).toBe(READY_YT);
    } finally {
      vi.useRealTimers();
    }
  });
});
