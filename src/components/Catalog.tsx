// "More sleep podcasts": the catalog (lib/catalog.ts), by style, each a tap
// to add. Presentational: SleepSetup adds the feed and opens the show.
import { useState } from "react";
import { CATALOG, CATALOG_STYLES, isAdded, type CatalogShow } from "../lib/catalog";
import type { FeedRef } from "../lib/store";

export function ShowCatalog({
  feeds,
  onAdd,
  onOpen,
  headingRef,
}: {
  feeds: FeedRef[];
  onAdd: (show: CatalogShow) => void;
  onOpen: (feedId: string) => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const [note, setNote] = useState("");
  return (
    <section aria-labelledby="catalog-title" className="space-y-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
      <div className="space-y-1">
        <h2 id="catalog-title" ref={headingRef} tabIndex={-1} className="text-xs uppercase tracking-widest text-[var(--ink-4)] outline-none">
          More sleep podcasts
        </h2>
        <p className="text-xs leading-relaxed text-[var(--ink-3)]">
          Checked for long, calm episodes. Added shows join your shuffle.
        </p>
      </div>
      {CATALOG_STYLES.map(({ style, label }) => {
        const shows = CATALOG.filter((s) => s.style === style);
        if (!shows.length) return null;
        return (
          <div key={style} className="space-y-1">
            <h3 className="text-sm font-semibold text-[var(--ink-2)]">{label}</h3>
            <ul className="divide-y divide-[var(--line)]">
              {shows.map((show) => {
                const feed = feeds.find((f) => f.url === show.url);
                const added = isAdded(show, feeds);
                return (
                  <li key={show.url} className="flex items-start gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-snug text-[var(--ink)]">
                        {show.title} <span className="text-xs font-normal text-[var(--ink-4)]">{show.by}</span>
                      </p>
                      <p className="text-xs leading-relaxed text-[var(--ink-3)]">{show.about}</p>
                    </div>
                    {added ? (
                      feed ? (
                        <button
                          onClick={() => onOpen(feed.id)}
                          aria-label={`Open ${show.title}`}
                          className="shrink-0 rounded border border-transparent px-3 py-1.5 text-xs text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]"
                        >
                          Added
                        </button>
                      ) : (
                        <span className="shrink-0 px-3 py-1.5 text-xs text-[var(--ink-4)]">Added</span>
                      )
                    ) : (
                      <button
                        onClick={() => { onAdd(show); setNote(`Added ${show.title} to your shows and your shuffle.`); }}
                        aria-label={`Add ${show.title}`}
                        className="shrink-0 rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--ink-2)] transition-colors hover:border-[var(--ink-4)]"
                      >
                        Add
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <p role="status" className="text-xs text-[var(--ink-3)] empty:hidden">{note}</p>
    </section>
  );
}
