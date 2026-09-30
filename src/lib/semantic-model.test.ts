import { describe, expect, test, vi, beforeEach } from "vitest";

// A stand-in for transformers.js: a download that reports progress and
// settles when told, and a pipe that embeds any title as a fixed vector.
let progress: ((e: unknown) => void) | undefined;
let finishDownload: () => void = () => {};
const pipelineCalls = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  pipeline: (_task: string, _model: string, opts: { progress_callback: (e: unknown) => void }) => {
    pipelineCalls();
    progress = opts.progress_callback;
    const pipe = async () => ({ data: new Float32Array(384).fill(0.1) });
    return new Promise((resolve) => { finishDownload = () => resolve(pipe); });
  },
}));

describe("embedTexts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    pipelineCalls.mockClear();
  });

  test("an aborted caller starts no model download", async () => {
    const { embedTexts } = await import("./semantic-model");
    const a = new AbortController();
    a.abort();
    await expect(embedTexts(["one"], undefined, undefined, a.signal)).rejects.toThrow();
    expect(pipelineCalls).not.toHaveBeenCalled();
  });

  test("a throwing listener can't abort the shared download; the latest caller hears it", async () => {
    const { embedTexts } = await import("./semantic-model");
    const first = embedTexts(["one"], undefined, () => { throw new Error("gone"); });
    const heard: number[] = [];
    const second = embedTexts(["two"], undefined, (pct) => heard.push(pct));
    await Promise.resolve();
    progress?.({ status: "progress", progress: 40 });
    expect(heard).toEqual([40]);
    finishDownload();
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(pipelineCalls).toHaveBeenCalledTimes(1);
  });

  test("a listener is dropped once its caller stops waiting, even after the first download", async () => {
    const { embedTexts } = await import("./semantic-model");
    const first = embedTexts(["one"], undefined, () => {});
    await Promise.resolve();
    finishDownload();
    await first;
    const late = vi.fn();
    await embedTexts(["two"], undefined, late); // model loaded: no listener kept
    progress?.({ status: "progress", progress: 99 });
    expect(late).not.toHaveBeenCalled();
  });

  test("aborting between titles stops the embedding, the model stays loaded", async () => {
    const { embedTexts, isModelWarm } = await import("./semantic-model");
    const a = new AbortController();
    const run = embedTexts(["one", "two", "three"], (done) => { if (done === 1) a.abort(); }, undefined, a.signal);
    await Promise.resolve();
    finishDownload();
    await expect(run).rejects.toThrow();
    expect(isModelWarm()).toBe(true);
  });
});
