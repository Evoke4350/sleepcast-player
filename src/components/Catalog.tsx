// "More sleep podcasts": the catalog (lib/catalog.ts) as shelves by style,
// Spotify's home style. A tap adds a show, or opens one you have.
// Presentational: SleepSetup adds the feed.
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
    <section aria-labelledby="catalog-title" className="space-y-6">
      <div className="space-y-1">
        <h2 id="catalog-title" ref={headingRef} tabIndex={-1} className="scroll-mt-20 text-2xl font-extrabold tracking-tight text-[var(--ink)] outline-none">
          More sleep podcasts
        </h2>
        <p className="text-sm text-[var(--ink-3)]">
          Picked by hand and checked for long, calm episodes. Tap one to add it to your shows and your shuffle.
        </p>
      </div>
      {CATALOG_STYLES.map(({ style, label }) => {
        const shows = CATALOG.filter((s) => s.style === style);
        if (!shows.length) return null;
        return (
          <div key={style} className="space-y-3">
            <h3 className="text-lg font-bold tracking-tight text-[var(--ink)]">{label}</h3>
            {/* A phone scrolls each shelf sideways; a wide screen lays it out. */}
            <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0 lg:grid lg:grid-cols-6 lg:gap-4 lg:overflow-visible">
              {shows.map((show) => {
                const feed = feeds.find((f) => f.url === show.url);
                const added = isAdded(show, feeds);
                return (
                  <li key={show.url} className="w-[136px] shrink-0 snap-start lg:w-auto">
                    <button
                      onClick={() => {
                        if (added) { if (feed) onOpen(feed.id); return; }
                        onAdd(show);
                        setNote(`Added ${show.title} to your shows and your shuffle.`);
                      }}
                      disabled={added && !feed}
                      aria-label={added ? `Open ${show.title}` : `Add ${show.title}`}
                      className="group grid w-full content-start gap-2 text-left"
                    >
                      <span className="relative block">
                        {/* Decorative: the button names the show. */}
                        <img src={show.art} alt="" width={144} height={144} loading="lazy" decoding="async" className="aspect-square w-full rounded-lg bg-[var(--raised)] object-cover shadow-[0_8px_20px_-12px_rgba(0,0,0,0.5)]" />
                        <span
                          aria-hidden="true"
                          className={`absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full shadow-md transition-transform group-hover:scale-105 ${
                            added ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--ink)] text-[var(--ground)]"
                          }`}
                        >
                          {added ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
                          )}
                        </span>
                      </span>
                      <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{show.title}</span>
                      <span className="-mt-1.5 line-clamp-2 text-xs leading-snug text-[var(--ink-3)]">{show.about}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <p role="status" className="text-sm text-[var(--ink-3)] empty:hidden">{note}</p>
    </section>
  );
}
