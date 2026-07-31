// Browser-only embedding model: MiniLM-L6-v2 (384-dim) via transformers.js.
// ~23MB quantized, downloaded once and cached by the browser. Episode-title
// vectors are additionally cached in localStorage so a feed is only embedded
// the first time it's seen.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const CACHE_KEY = "sleepcast2.titlevecs"; // { [hash]: number[] } quantized int8
const CACHE_CAP = 6000; // vectors; ~1.5MB at int8

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(onDownload?: (pct: number) => void) {
  if (!extractor) {
    extractor = pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      progress_callback: (e) => {
        const p = e as { status?: string; progress?: number };
        if (p.status === "progress" && typeof p.progress === "number") {
          onDownload?.(Math.round(p.progress));
        }
      },
    }).catch((e: unknown) => {
      extractor = null; // a transient failure must not brick the feature until reload
      throw e;
    });
  }
  return extractor;
}

export function isModelWarm(): boolean {
  return extractor !== null;
}

// djb2 — good enough to key title strings.
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

type VecCache = Record<string, number[]>;

function loadCache(): VecCache {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveCache(cache: VecCache) {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_CAP) {
    for (const k of keys.slice(0, keys.length - CACHE_CAP)) delete cache[k];
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* quota: vectors recompute next time */ }
}

const dequant = (q: number[]) => Float32Array.from(q, (x) => x / 127);

// Embed texts, consulting the persistent cache; onProgress(done, total) fires
// per fresh embedding (cached hits are free).
export async function embedTexts(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  onModelProgress?: (pct: number) => void
): Promise<Float32Array[]> {
  const cache = loadCache();
  const out: (Float32Array | null)[] = texts.map((t) => {
    const hit = cache[hash(t)];
    return hit ? dequant(hit) : null;
  });
  const missing = out.flatMap((v, i) => (v === null ? [i] : []));
  if (missing.length) {
    const pipe = await getExtractor(onModelProgress);
    let done = 0;
    for (const i of missing) {
      const res = await pipe(texts[i], { pooling: "mean", normalize: true });
      const vec = new Float32Array(res.data as Float32Array);
      out[i] = vec;
      cache[hash(texts[i])] = Array.from(vec, (x) => Math.round(x * 127));
      onProgress?.(++done, missing.length);
    }
    saveCache(cache);
  }
  return out as Float32Array[];
}
