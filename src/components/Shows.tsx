// The Podcasts tab's two views: your shows as an artwork grid, and one show
// with its episodes. Presentational: SleepSetup owns the feeds, their
// statuses and starting a night.
import { useState } from "react";
import type { Episode } from "../lib/engine";
import { formatTime } from "../lib/engine";
import type { FeedRef } from "../lib/store";

export interface ShowStatus {
  loading: boolean;
  error: string | null;
  episodes: Episode[];
  artwork?: string;
}

/** A show's tile art: its own artwork, or a gradient from its id while that
 *  hasn't loaded (or the feed has none). */
export function ShowArt({ feed, artwork, className = "" }: { feed: FeedRef; artwork?: string; className?: string }) {
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
  const hue = [...feed.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <div
      aria-hidden="true"
      className={`flex aspect-square w-full items-end rounded-[10px] p-2.5 ${className}`}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 30%))` }}
    >
      <span className="text-[13px] font-extrabold leading-tight text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.25)]">
        {feed.title}
      </span>
    </div>
  );
}

export function ShowGrid({
  feeds,
  statuses,
  onOpen,
  onAdd,
}: {
  feeds: FeedRef[];
  statuses: Record<string, ShowStatus | undefined>;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {feeds.map((feed) => {
        const st = statuses[feed.id];
        const note = st?.error
          ? "couldn't load"
          : st?.loading || !st
            ? "loading…"
            : feed.enabled
              ? `${st.episodes.length} episodes`
              : "not in shuffle";
        return (
          <button key={feed.id} onClick={() => onOpen(feed.id)} className="grid gap-1.5 text-left">
            <ShowArt feed={feed} artwork={st?.artwork} className={feed.enabled ? "" : "opacity-45"} />
            <span className="text-[13px] font-semibold leading-tight text-[var(--ink)]">{feed.title}</span>
            <span className={`text-xs ${st?.error && feed.enabled ? "text-[var(--danger)]" : "text-[var(--ink-3)]"}`}>{note}</span>
          </button>
        );
      })}
      <button onClick={onAdd} className="grid gap-1.5 text-left">
        <span className="grid aspect-square w-full place-items-center rounded-[10px] border-[1.5px] border-dashed border-[var(--line)] bg-[var(--raised)] text-3xl text-[var(--ink-3)]">
          +
        </span>
        <span className="text-[13px] font-semibold leading-tight text-[var(--ink)]">Add a show</span>
        <span className="text-xs text-[var(--ink-3)]">paste a feed</span>
      </button>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" });
function episodeDate(raw: string): string {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? DATE.format(t) : "";
}

export function ShowPage({
  feed,
  status,
  heard,
  positions,
  onBack,
  onPlay,
  onShuffle,
  onToggleShuffle,
  onRemove,
}: {
  feed: FeedRef;
  status: ShowStatus | undefined;
  /** Episodes heard enough to count as played. */
  heard: Set<string>;
  /** Where you went under in an episode, in seconds. */
  positions: Record<string, number>;
  onBack: () => void;
  onPlay: (ep: Episode) => void;
  onShuffle: () => void;
  onToggleShuffle: () => void;
  onRemove?: () => void;
}) {
  const episodes = status?.episodes ?? [];
  const [shown, setShown] = useState(40);
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--ink-3)] hover:text-[var(--ink-2)]">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Podcasts
      </button>

      <div className="grid grid-cols-[112px_1fr] items-end gap-4">
        <ShowArt feed={feed} artwork={status?.artwork} />
        <div className="space-y-1">
          <h2 className="text-xl font-bold leading-tight tracking-tight text-[var(--ink)]">{feed.title}</h2>
          <p className="text-[13px] text-[var(--ink-3)]">
            {status?.loading ? "loading episodes…" : status?.error ? "couldn't load this show" : `${episodes.length} episodes`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => episodes[0] && onPlay(episodes[0])}
          disabled={!episodes.length}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--accent)] px-4 py-2.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          Play latest
        </button>
        <button
          onClick={onShuffle}
          disabled={!episodes.length}
          className="inline-flex items-center gap-2 rounded-full bg-[var(--raised)] px-4 py-2.5 text-sm font-bold text-[var(--ink)] disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
            <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
          </svg>
          Shuffle show
        </button>
      </div>

      <label className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
        <span>
          <span className="block text-sm font-semibold text-[var(--ink)]">In tonight&apos;s shuffle</span>
          <span className="block text-xs text-[var(--ink-3)]">The moon shuffles every show that&apos;s on.</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={feed.enabled}
          onChange={onToggleShuffle}
          className="h-5 w-5 cursor-pointer accent-[var(--accent)]"
        />
      </label>

      <ol className="divide-y divide-[var(--line)]">
        {episodes.slice(0, shown).map((ep) => {
          const at = positions[ep.id] ?? 0;
          const played = heard.has(ep.id);
          return (
            <li key={ep.id}>
              <button onClick={() => onPlay(ep)} className="grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-0.5 py-3 text-left">
                <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-4)]">{episodeDate(ep.date)}</span>
                <span className="row-span-3 grid h-9 w-9 place-items-center rounded-full border-[1.5px] border-[var(--line)] text-[var(--ink)]">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
                </span>
                <span className="font-semibold leading-snug text-[var(--ink)]">{ep.title}</span>
                <span className="text-[12.5px] text-[var(--ink-3)]">
                  {at > 0 ? `you went under at ${formatTime(at)}` : played ? "played" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {episodes.length > shown && (
        <button onClick={() => setShown((n) => n + 40)} className="w-full rounded-xl bg-[var(--raised)] py-2.5 text-sm font-semibold text-[var(--ink-2)]">
          Show more ({episodes.length - shown} older)
        </button>
      )}

      {onRemove && (
        <button onClick={onRemove} className="w-full py-2 text-xs text-[var(--ink-4)] hover:text-[var(--danger)]">
          Remove this show
        </button>
      )}
    </div>
  );
}
