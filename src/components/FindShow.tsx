// "Find a podcast": a search box over Apple's directory (lib/podcast-search),
// results as rows, a tap adds one. Presentational like the catalog:
// SleepSetup adds the feed.
import { useEffect, useRef, useState } from "react";
import { searchPodcasts, SEARCH_MIN_CHARS, type FoundShow } from "../lib/podcast-search";
import type { FeedRef } from "../lib/store";

/** How long after the last keystroke the search goes. */
const DEBOUNCE_MS = 400;

export function FindShow({
  feeds,
  onAdd,
  onOpen,
  inputRef,
}: {
  feeds: FeedRef[];
  onAdd: (show: FoundShow) => void;
  onOpen: (feedId: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FoundShow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < SEARCH_MIN_CHARS) { setHits(null); setBusy(false); setError(null); return; }
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setError(null);
    const t = setTimeout(() => {
      searchPodcasts(q, abort.signal)
        .then((found) => { if (!abort.signal.aborted) { setHits(found); setBusy(false); } })
        .catch((e: unknown) => {
          if (abort.signal.aborted) return;
          setError(e instanceof Error ? e.message : "Couldn't search.");
          setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); abort.abort(); };
  }, [query]);

  return (
    <section aria-labelledby="find-title" className="space-y-3">
      <div className="space-y-1">
        <h2 id="find-title" className="text-2xl font-extrabold tracking-tight text-[var(--ink)]">Find a podcast</h2>
        <p className="text-sm text-[var(--ink-3)]">Any show in Apple&apos;s podcast directory. Your words go through sleepcast.pro, which doesn&apos;t log them.</p>
      </div>
      <label className="relative block lg:max-w-xl">
        <span className="sr-only">Search podcasts</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--ink-3)]" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>
        <input
          id="find-podcast"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Show name"
          autoComplete="off"
          className="w-full rounded-full bg-[var(--raised)] py-3 pl-12 pr-4 text-base text-[var(--ink)] placeholder:text-[var(--ink-3)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
      </label>
      <p role="status" className="text-sm text-[var(--ink-3)] empty:hidden">
        {error ? "" : busy ? "Searching…" : hits && hits.length === 0 ? `No podcasts found for “${query.trim()}”.` : note}
      </p>
      {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
      {hits && hits.length > 0 && (
        <ul className="-mx-2 lg:grid lg:grid-cols-2 lg:gap-x-6">
          {hits.map((show) => {
            const feed = feeds.find((f) => f.url === show.feedUrl);
            return (
              <li key={show.feedUrl}>
                <button
                  onClick={() => {
                    if (feed) { onOpen(feed.id); return; }
                    onAdd(show);
                    setNote(`Added ${show.title} to your shows and your shuffle.`);
                  }}
                  aria-label={feed ? `Open ${show.title}` : `Add ${show.title}`}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--raised)]"
                >
                  <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-[var(--raised)]">
                    {show.art ? <img src={show.art} alt="" width={56} height={56} loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <span aria-hidden="true" className="text-xl text-[var(--ink-4)]">☾</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-[var(--ink)]">{show.title}</span>
                    <span className="block truncate text-[13px] text-[var(--ink-3)]">{[show.author, show.episodes ? `${show.episodes} episodes` : ""].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${feed ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--ink)] text-[var(--ground)]"}`}
                  >
                    {feed ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
