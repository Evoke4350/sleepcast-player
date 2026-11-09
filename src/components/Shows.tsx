// The Podcasts tab's two views: your shows (Library, with Jump back in
// above), and one show with its episodes. Presentational: SleepSetup owns
// the feeds, their statuses and starting a night.
import { useEffect, useRef, useState } from "react";
import type { Episode } from "../lib/engine";
import { formatTime } from "../lib/engine";
import { formatLength, orderEpisodes, typicalLength, type EpisodeOrder } from "../lib/feed-details";
import type { CatalogShow } from "../lib/catalog";
import { arrangeShows, loadLibraryView, saveLibraryView, type LibraryFilter, type LibrarySort, type LibraryView } from "../lib/library";
import type { FeedRef } from "../lib/store";

export interface ShowStatus {
  loading: boolean;
  error: string | null;
  episodes: Episode[];
  artwork?: string;
  author?: string;
  about?: string;
  notes?: Record<string, string>;
}

function showHue(feed: FeedRef): number {
  return [...feed.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
}

/** A show's tile art: its own artwork, or a gradient from its id while that
 *  hasn't loaded (or the feed has none). `label` writes the title on the
 *  gradient; a thumbnail too small to read it leaves it off. */
export function ShowArt({ feed, artwork, className = "", label = true }: { feed: FeedRef; artwork?: string; className?: string; label?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (artwork && !broken) {
    return (
      <img
        src={artwork}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={`aspect-square w-full rounded-[10px] bg-[var(--raised)] object-cover ${className}`}
      />
    );
  }
  const hue = showHue(feed);
  return (
    <div
      aria-hidden="true"
      className={`flex aspect-square w-full items-end rounded-[10px] p-2.5 ${className}`}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 30%))` }}
    >
      {label && (
        <span className="text-[13px] font-extrabold leading-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.25)]">
          {feed.title}
        </span>
      )}
    </div>
  );
}

function showNote(st: ShowStatus | undefined): string {
  if (st?.error) return "Couldn't load";
  if (st?.loading || !st) return "Loading…";
  const count = `${st.episodes.length} episodes`;
  return st.author ? `${st.author} · ${count}` : count;
}

function CheckIcon({ className }: { className: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

const FILTERS: { filter: LibraryFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "on", label: "In shuffle" },
  { filter: "off", label: "Off" },
];

/** Your shows, Spotify's library style: chips to filter by the shuffle, a
 *  sort, and a list or a grid. */
export function Library({
  feeds,
  statuses,
  lastPlayed,
  onOpen,
  onAdd,
}: {
  feeds: FeedRef[];
  statuses: Record<string, ShowStatus | undefined>;
  /** When each show last played, by feed id (lastPlayedByFeed). */
  lastPlayed: Record<string, number>;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [view, setView] = useState<LibraryView>(loadLibraryView);
  const shows = arrangeShows(feeds, filter, sort, lastPlayed);
  const offCount = feeds.filter((f) => !f.enabled).length;

  const addLabel = (
    <>
      <span className="text-[15px] font-semibold leading-tight text-[var(--ink)]">Add a show</span>
      <span className="text-[13px] text-[var(--ink-3)]">Browse below or paste a link</span>
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="group" aria-label="Show">
        {FILTERS.filter((f) => f.filter !== "off" || offCount > 0).map((f) => (
          <button
            key={f.filter}
            aria-pressed={filter === f.filter}
            onClick={() => setFilter(f.filter)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
              filter === f.filter ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--raised)] text-[var(--ink-2)] hover:text-[var(--ink)]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={() => setSort(sort === "recent" ? "az" : "recent")}
          aria-label={`Sorted by ${sort === "recent" ? "recently played" : "title"}. Sort by ${sort === "recent" ? "title" : "recently played"}`}
          className="-ml-1 inline-flex items-center gap-1.5 rounded-full px-1 py-1 text-[13px] font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4" />
          </svg>
          {sort === "recent" ? "Recently played" : "A–Z"}
        </button>
        <button
          onClick={() => { const next = view === "list" ? "grid" : "list"; setView(next); saveLibraryView(next); }}
          aria-label={view === "list" ? "Show as a grid" : "Show as a list"}
          title={view === "list" ? "Show as a grid" : "Show as a list"}
          className="grid h-9 w-9 place-items-center rounded-full text-[var(--ink-2)] hover:bg-[var(--raised)] hover:text-[var(--ink)]"
        >
          {view === "list" ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="18" r="1" fill="currentColor" /></svg>
          )}
        </button>
      </div>

      {!shows.length && (
        <p className="py-4 text-sm text-[var(--ink-3)]">{filter === "off" ? "Every show is in the shuffle." : "None of your shows are in the shuffle. Open one and add it."}</p>
      )}

      {view === "list" ? (
        <ul className="-mx-2 lg:grid lg:grid-cols-2 lg:gap-x-6">
          {shows.map((feed) => {
            const st = statuses[feed.id];
            return (
              <li key={feed.id}>
                <button data-show-id={feed.id} onClick={() => onOpen(feed.id)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--raised)]">
                  <span className="w-16 shrink-0"><ShowArt feed={feed} artwork={st?.artwork} label={false} className={`rounded-md ${feed.enabled ? "" : "opacity-45"}`} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-semibold text-[var(--ink)]">{feed.title}</span>
                    <span className={`flex items-center gap-1 text-[13px] ${st?.error && feed.enabled ? "text-[var(--danger)]" : "text-[var(--ink-3)]"}`}>
                      {feed.enabled ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text)]" /> : null}
                      <span className="sr-only">{feed.enabled ? "In shuffle, " : "Not in shuffle, "}</span>
                      <span className="truncate">{showNote(st)}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button onClick={onAdd} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-[var(--raised)]">
              <span className="grid h-16 w-16 shrink-0 place-items-center rounded-md border-[1.5px] border-dashed border-[var(--control)] text-2xl text-[var(--ink-3)]" aria-hidden="true">+</span>
              <span className="grid">{addLabel}</span>
            </button>
          </li>
        </ul>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6 lg:gap-4">
          {shows.map((feed) => {
            const st = statuses[feed.id];
            return (
              <button key={feed.id} data-show-id={feed.id} onClick={() => onOpen(feed.id)} className="grid content-start gap-1.5 rounded-[10px] text-left">
                <ShowArt feed={feed} artwork={st?.artwork} className={feed.enabled ? "" : "opacity-45"} />
                <span className="truncate text-[13px] font-semibold leading-tight text-[var(--ink)]">{feed.title}</span>
                <span className={`flex items-center gap-1 text-xs ${st?.error && feed.enabled ? "text-[var(--danger)]" : "text-[var(--ink-3)]"}`}>
                  {feed.enabled ? <CheckIcon className="h-3 w-3 shrink-0 text-[var(--accent-text)]" /> : null}
                  <span className="sr-only">{feed.enabled ? "In shuffle, " : "Not in shuffle, "}</span>
                  <span className="truncate">{st?.error ? "Couldn't load" : st?.loading || !st ? "Loading…" : `${st.episodes.length} episodes`}</span>
                </span>
              </button>
            );
          })}
          <button onClick={onAdd} className="grid content-start gap-1.5 text-left">
            <span className="grid aspect-square w-full place-items-center rounded-[10px] border-[1.5px] border-dashed border-[var(--control)] text-3xl text-[var(--ink-3)]" aria-hidden="true">+</span>
            <span className="text-[13px] font-semibold leading-tight text-[var(--ink)]">Add a show</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** "Jump back in": episodes you went under in, across your shows, as a
 *  shelf of cards. Each starts the night where you went under. */
export function JumpBackIn({
  items,
  positions,
  onPlay,
}: {
  items: { ep: Episode; feed: FeedRef; artwork?: string }[];
  positions: Record<string, number>;
  onPlay: (ep: Episode) => void;
}) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="jump-back-title" className="space-y-3">
      <h2 id="jump-back-title" className="text-xl font-bold tracking-tight text-[var(--ink)]">Jump back in</h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] md:mx-0 md:px-0 lg:grid lg:grid-cols-6 lg:overflow-visible lg:[&>li:nth-child(n+7)]:hidden">
        {items.map(({ ep, feed, artwork }) => {
          const at = positions[ep.id] ?? 0;
          return (
            <li key={ep.id} className="w-[140px] shrink-0 snap-start lg:w-auto">
              <button
                onClick={() => onPlay(ep)}
                aria-label={`Play ${ep.title}, ${feed.title}, from ${formatTime(at)}`}
                className="group grid w-full gap-2 text-left"
              >
                <span className="relative block">
                  <ShowArt feed={feed} artwork={artwork} className="rounded-lg" />
                  <span className="absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow-md transition-transform group-hover:scale-105">
                    <PlayIcon className="ml-0.5 h-4 w-4" />
                  </span>
                  {ep.durationSec ? (
                    <span className="absolute inset-x-2 bottom-0 block h-[3px] translate-y-1.5 overflow-hidden rounded-full bg-[var(--line)]">
                      <span className="block h-full bg-[var(--accent)]" style={{ width: `${Math.min(100, (at / ep.durationSec) * 100)}%` }} />
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-[var(--ink)]">{ep.title}</span>
                <span className="-mt-1 truncate text-xs text-[var(--ink-3)]">{feed.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
function episodeDate(raw: string): string {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? DATE.format(t) : "";
}

const ORDERS: { order: EpisodeOrder; label: string }[] = [
  { order: "newest", label: "Newest" },
  { order: "longest", label: "Longest" },
  { order: "unplayed", label: "Not played" },
];

type ShowTab = "episodes" | "about" | "similar";

/** A catalog show beside this one, for "More like this". */
export interface SimilarShow {
  show: CatalogShow;
  /** Its feed, when it's already one of yours. */
  feedId?: string;
  added: boolean;
}

function PlayIcon({ className }: { className: string }) {
  return <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>;
}

/** How far into an episode you went under, as a thin bar. */
function UnderBar({ at, of }: { at: number; of?: number }) {
  if (!of || at <= 0) return null;
  return (
    <span aria-hidden="true" className="block h-[3px] w-14 overflow-hidden rounded-full bg-[var(--line)]">
      <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, (at / of) * 100)}%` }} />
    </span>
  );
}

export function ShowPage({
  feed,
  status,
  heard,
  positions,
  styleLabel,
  similar,
  onBack,
  onPlay,
  onShuffle,
  onToggleShuffle,
  onRemove,
  onAddSimilar,
  onOpenShow,
}: {
  feed: FeedRef;
  status: ShowStatus | undefined;
  /** Episodes heard enough to count as played. */
  heard: Set<string>;
  /** Where you went under in an episode, in seconds. */
  positions: Record<string, number>;
  /** The catalog's kind of show ("Stories"), when the show is in it. */
  styleLabel?: string;
  /** Catalog shows of the same kind; none hides "More like this". */
  similar: SimilarShow[];
  onBack: () => void;
  onPlay: (ep: Episode) => void;
  onShuffle: () => void;
  onToggleShuffle: () => void;
  onRemove?: () => void;
  onAddSimilar: (show: CatalogShow) => void;
  onOpenShow: (feedId: string) => void;
}) {
  const episodes = status?.episodes ?? [];
  const notes = status?.notes ?? {};
  const [shown, setShown] = useState(40);
  const [order, setOrder] = useState<EpisodeOrder>("newest");
  const [tab, setTab] = useState<ShowTab>("episodes");
  const [artBroken, setArtBroken] = useState(false);
  // Opening a show replaces the grid: focus lands on its title, not the top.
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, []);

  const listed = orderEpisodes(episodes, order, heard, positions);
  const usual = typicalLength(episodes.map((e) => e.durationSec));
  // The newest episode you went under in: where Spotify puts a trailer, the
  // one you're most likely to want back.
  const resume = episodes.find((ep) => (positions[ep.id] ?? 0) > 0);
  const lengthOf = (ep: Episode) => (ep.durationSec ? formatLength(ep.durationSec) : "");
  const meta = [
    styleLabel,
    status?.loading ? "Loading episodes…" : status?.error ? "Couldn't load this show" : `${episodes.length} episodes`,
    usual ? `usually ${formatLength(usual)}` : "",
  ].filter(Boolean);
  const tabs: { id: ShowTab; label: string }[] = [
    { id: "episodes", label: "Episodes" },
    { id: "about", label: "About" },
    ...(similar.length ? [{ id: "similar" as const, label: "More like this" }] : []),
  ];
  const art = status?.artwork && !artBroken ? status.artwork : undefined;
  const hue = showHue(feed);

  const aboutPanel = (
    <div className="space-y-3">
      <h3 className="hidden text-xs font-semibold uppercase tracking-widest text-[var(--ink-4)] lg:block">About</h3>
      {status?.about ? (
        <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">{status.about}</p>
      ) : (
        <p className="text-sm text-[var(--ink-3)]">{status?.loading ? "Loading…" : "This show doesn't describe itself."}</p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {status?.author && (<><dt className="text-[var(--ink-4)]">By</dt><dd className="text-[var(--ink-2)]">{status.author}</dd></>)}
        {usual && (<><dt className="text-[var(--ink-4)]">Usually</dt><dd className="text-[var(--ink-2)]">{formatLength(usual)} an episode</dd></>)}
        <dt className="text-[var(--ink-4)]">Shuffle</dt>
        <dd className="text-[var(--ink-2)]">{feed.enabled ? "On: the moon can pick from it." : "Off: the moon leaves it out."}</dd>
      </dl>
      {onRemove && (
        <button onClick={onRemove} className="pt-1 text-xs text-[var(--ink-4)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--danger)]">
          Remove this show
        </button>
      )}
    </div>
  );

  const similarPanel = similar.length > 0 && (
    <div className="space-y-2">
      <h3 className="hidden text-xs font-semibold uppercase tracking-widest text-[var(--ink-4)] lg:block">More like this</h3>
      <ul className="divide-y divide-[var(--line)]">
        {similar.map(({ show, feedId, added }) => (
          <li key={show.url} className="flex items-center gap-3 py-2.5">
            <img src={show.art} alt="" width={48} height={48} loading="lazy" decoding="async" className="h-12 w-12 shrink-0 rounded-md bg-[var(--raised)] object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--ink)]">{show.title}</p>
              <p className="truncate text-xs text-[var(--ink-3)]">{show.about}</p>
            </div>
            {added ? (
              feedId ? (
                <button onClick={() => onOpenShow(feedId)} aria-label={`Open ${show.title}`} className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-[var(--ink-3)] hover:text-[var(--ink)]">
                  Open
                </button>
              ) : (
                <span className="shrink-0 px-3 py-1.5 text-xs text-[var(--ink-4)]">Added</span>
              )
            ) : (
              <button onClick={() => onAddSimilar(show)} aria-label={`Add ${show.title}`} className="shrink-0 rounded-full border border-[var(--control)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] hover:border-[var(--ink-3)]">
                Add
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* The header takes its colour from the show: its artwork, blurred
          large behind it, fading into the page. Runs to the screen's edges on
          a phone; a rounded panel on a wide screen. */}
      <header className="relative -mx-4 -mt-8 overflow-hidden px-4 pb-4 pt-6 md:mx-0 md:-mt-4 md:rounded-3xl md:px-8 md:pt-6">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {art ? (
            <img src={art} alt="" onError={() => setArtBroken(true)} className="h-full w-full scale-125 object-cover opacity-60 blur-3xl saturate-150" />
          ) : (
            <div className="h-full w-full opacity-50" style={{ background: `linear-gradient(160deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 30%))` }} />
          )}
          <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, color-mix(in srgb, var(--ground) 30%, transparent), color-mix(in srgb, var(--ground) 72%, transparent) 55%, var(--ground))" }} />
        </div>

        <div className="relative space-y-5">
          <button onClick={onBack} className="-ml-1 inline-flex items-center gap-1 rounded-full py-1 pl-1 pr-2 text-sm font-semibold text-[var(--ink-2)] hover:text-[var(--ink)]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            Podcasts
          </button>

          {/* A phone: art beside the title, the rest full width below. A wide
              screen: everything beside the art. */}
          <div className="grid grid-cols-[128px_1fr] gap-x-4 gap-y-5 sm:grid-cols-[168px_1fr] lg:grid-cols-[216px_1fr] lg:gap-x-8 lg:gap-y-4">
            <ShowArt feed={feed} artwork={status?.artwork} className="shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)] lg:row-span-3" />
            <div className="min-w-0 space-y-1.5 self-center lg:self-end">
              <h2 ref={titleRef} tabIndex={-1} className="text-2xl font-extrabold leading-[1.1] tracking-tight text-[var(--ink)] outline-none [text-wrap:balance] sm:text-3xl lg:text-5xl">
                {feed.title}
              </h2>
              {status?.author && <p className="truncate text-[15px] font-semibold text-[var(--ink-2)] lg:text-base">{status.author}</p>}
            </div>

          <p role="status" className="col-span-2 text-sm text-[var(--ink-3)] lg:col-span-1">{meta.join(" · ")}</p>

          <div className="col-span-2 flex items-center gap-3 lg:col-span-1 lg:self-end">
            <button
              role="switch"
              aria-checked={feed.enabled}
              onClick={onToggleShuffle}
              className={`inline-flex items-center gap-1.5 rounded-full border-[1.5px] px-4 py-2 text-sm font-bold transition-colors ${
                feed.enabled ? "border-[var(--ink-3)] text-[var(--ink)]" : "border-[var(--control)] text-[var(--ink-2)]"
              }`}
            >
              {feed.enabled ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-[var(--accent-text)]" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-4 w-4" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              )}
              {feed.enabled ? "In shuffle" : "Add to shuffle"}
            </button>
            <button
              onClick={onShuffle}
              disabled={!episodes.length}
              aria-label="Shuffle this show"
              title="Shuffle this show"
              className="grid h-10 w-10 place-items-center rounded-full text-[var(--ink-2)] hover:bg-[var(--raised)] hover:text-[var(--ink)] disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
                <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </svg>
            </button>
            <button
              onClick={() => episodes[0] && onPlay(episodes[0])}
              disabled={!episodes.length}
              aria-label="Play the latest episode"
              title="Play the latest episode"
              className="ml-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] shadow-[0_8px_20px_-8px_rgba(0,0,0,0.5)] transition-transform hover:scale-105 disabled:opacity-40"
            >
              <PlayIcon className="ml-0.5 h-6 w-6" />
            </button>
          </div>
          </div>
        </div>
      </header>

      {resume && (
        <button
          onClick={() => onPlay(resume)}
          className="flex w-full items-center gap-4 rounded-2xl bg-[var(--raised)] p-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--raised)_80%,var(--ink)_6%)] md:max-w-xl"
        >
          <span className="relative w-16 shrink-0">
            <ShowArt feed={feed} artwork={status?.artwork} label={false} className="rounded-lg" />
            <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/35 text-white"><PlayIcon className="ml-0.5 h-6 w-6" /></span>
          </span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-[11px] font-bold uppercase tracking-wider text-[var(--accent-text)]">Pick up where you went under</span>
            <span className="line-clamp-2 block font-semibold leading-snug text-[var(--ink)]">{resume.title}</span>
            <span className="flex items-center gap-2 text-xs text-[var(--ink-3)]">
              <span className="tabular-nums">at {formatTime(positions[resume.id])}{resume.durationSec ? ` of ${formatLength(resume.durationSec)}` : ""}</span>
              <UnderBar at={positions[resume.id]} of={resume.durationSec} />
            </span>
          </span>
        </button>
      )}

      {/* A phone takes these as tabs; a wide screen lays About and More like
          this beside the episodes. */}
      <div role="tablist" aria-label={feed.title} className="flex gap-6 border-b border-[var(--line)] lg:hidden">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`show-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`show-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 pb-2.5 text-[15px] font-bold transition-colors ${
              tab === t.id ? "border-[var(--accent)] text-[var(--ink)]" : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:gap-12">
        <section id="show-panel-episodes" role="tabpanel" aria-labelledby="show-tab-episodes" className={`space-y-2 ${tab === "episodes" ? "" : "hidden"} lg:block`}>
          <div className="flex items-center gap-2 overflow-x-auto pb-1" role="group" aria-label="Order episodes">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5 shrink-0 text-[var(--ink-3)]" aria-hidden="true">
              <path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
            </svg>
            {ORDERS.map((o) => (
              <button
                key={o.order}
                aria-pressed={order === o.order}
                onClick={() => { setOrder(o.order); setShown(40); }}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
                  order === o.order ? "bg-[var(--ink)] text-[var(--ground)]" : "bg-[var(--raised)] text-[var(--ink-2)] hover:text-[var(--ink)]"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {order === "unplayed" && !listed.length && episodes.length > 0 && (
            <p className="py-6 text-sm text-[var(--ink-3)]">You've played every episode of this show.</p>
          )}

          <ol className="divide-y divide-[var(--line)]">
            {listed.slice(0, shown).map((ep) => {
              const at = positions[ep.id] ?? 0;
              const played = heard.has(ep.id);
              const note = notes[ep.id];
              const facts = [episodeDate(ep.date), lengthOf(ep)].filter(Boolean).join(" · ");
              return (
                <li key={ep.id}>
                  <button
                    onClick={() => onPlay(ep)}
                    aria-label={`Play ${ep.title}${facts ? `, ${facts}` : ""}${at > 0 ? `, you went under at ${formatTime(at)}` : played ? ", played" : ""}`}
                    className="group grid w-full grid-cols-[56px_1fr] gap-x-3.5 gap-y-2 py-4 text-left"
                  >
                    <ShowArt feed={feed} artwork={status?.artwork} label={false} className="rounded-md" />
                    <span className="min-w-0 self-center">
                      <span className="line-clamp-2 font-semibold leading-snug text-[var(--ink)] group-hover:underline group-hover:decoration-[var(--line)] group-hover:underline-offset-4">{ep.title}</span>
                      {at > 0 ? (
                        <span className="mt-0.5 block text-[13px] font-semibold text-[var(--accent-text)]">You went under at {formatTime(at)}</span>
                      ) : played ? (
                        <span className="mt-0.5 flex items-center gap-1 text-[13px] text-[var(--ink-4)]">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                          Played
                        </span>
                      ) : null}
                    </span>
                    {note && <span className="col-span-2 line-clamp-2 text-sm leading-relaxed text-[var(--ink-3)]">{note}</span>}
                    <span className="col-span-2 flex items-center gap-3">
                      <span className="text-[13px] tabular-nums text-[var(--ink-2)]">{facts}</span>
                      <UnderBar at={at} of={ep.durationSec} />
                      <span className="ml-auto grid h-10 w-10 place-items-center rounded-full bg-[var(--ink)] text-[var(--ground)] transition-transform group-hover:scale-105">
                        <PlayIcon className="ml-0.5 h-4.5 w-4.5" />
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {listed.length > shown && (
            <button onClick={() => setShown((n) => n + 40)} className="w-full rounded-xl bg-[var(--raised)] py-2.5 text-sm font-semibold text-[var(--ink-2)]">
              Show more ({listed.length - shown} {order === "newest" ? "older" : "more"})
            </button>
          )}
        </section>

        <aside className="space-y-10 lg:sticky lg:top-20">
          <section id="show-panel-about" role="tabpanel" aria-labelledby="show-tab-about" className={`${tab === "about" ? "" : "hidden"} lg:block`}>
            {aboutPanel}
          </section>
          {similarPanel && (
            <section id="show-panel-similar" role="tabpanel" aria-labelledby="show-tab-similar" className={`${tab === "similar" ? "" : "hidden"} lg:block`}>
              {similarPanel}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
