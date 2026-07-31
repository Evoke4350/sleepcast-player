import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, FeedRef } from "@/lib/store";
import { loadBlocked, loadPositions } from "@/lib/store";
import { searchEpisodes } from "@/lib/episode-search";
import {
  loadState,
  saveState,
  addCustomFeed,
  removeCustomFeed,
  cacheFeedXml,
  getCachedFeedXml,
  loadLastEpisode,
} from "@/lib/store";
import { diverseByMeta, parseFeedXml, formatTime } from "@/lib/engine";
import type { Episode } from "@/lib/engine";
import { loadNights, setSelfLabel, loadParams, saveParams } from "@/lib/rest/ledger";
import { tightenAfterFalsePositive } from "@/lib/rest/calibrate";
import type { RestNight } from "@/lib/rest/types";
import { diversePick } from "@/lib/semantic-math";
import { FEEL_PRESETS } from "@/lib/timer-feel";

const VARIED_N = 8;
const EMBED_CAP = 96; // max titles to embed per varied-night run (~10s cold on a phone)

interface FeedStatus {
  loading: boolean;
  episodeCount: number | null;
  error: string | null;
  episodes: Episode[];
  artwork?: string;
}

export interface SleepSetupProps {
  onStart: (
    pool: Episode[],
    timerMinutes: number,
    skipIntroByFeedId: Record<string, number>,
    feedTitles: Record<string, string>,
    artworkByFeedId: Record<string, string>,
    leadEpisode?: Episode | null,
    wasVaried?: boolean,
    leadPosition?: number
  ) => void;
}

// No-PII aggregate beacon: a single allowlisted event name, fire-and-forget.
// The server (middleware) tallies whole numbers only — no identity, no payload.
// GET + keepalive rather than sendBeacon: Astro's CSRF guard forbids the POST.
function beacon(name: string) {
  try {
    fetch(`/api/_event?e=${encodeURIComponent(name)}`, { method: "GET", keepalive: true, cache: "no-store" });
  } catch { /* ignore */ }
}

export function SleepSetup({ onStart }: SleepSetupProps) {
  const [appState, setAppState] = useState<AppState>(() => loadState());
  const [feedStatuses, setFeedStatuses] = useState<Record<string, FeedStatus>>({});
  const [customUrl, setCustomUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [variedBusy, setVariedBusy] = useState(false);
  const [variedNote, setVariedNote] = useState<string | null>(null);
  const [goldenPending, setGoldenPending] = useState(false);
  // Returning-listener warmth: the show they drifted off to (for "the exact one
  // again"), and last night's record (to greet + ask how they slept, which
  // doubles as the detector's self-label).
  const leadRef = useRef<Episode | null>(null);
  const leadPositionRef = useRef(0);
  const [query, setQuery] = useState("");
  const [feedError, setFeedError] = useState("");
  const [lastEpisode] = useState(() => loadLastEpisode());
  const [greetNight, setGreetNight] = useState<RestNight | null>(() => {
    const last = loadNights().at(-1) ?? null;
    return last && last.sleptAtMs !== null && last.selfLabel === undefined ? last : null;
  });

  // A returning listener saw the welcome — fire once. (Aggregate, no PII.)
  useEffect(() => {
    if (lastEpisode || greetNight) beacon("welcome_shown");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Golden path only overrides the timer if the user hasn't touched it this session
  const [timerTouched, setTimerTouched] = useState(false);

  const timerMinutes = appState.settings.timerMinutes;
  const quarterHourRule = appState.settings.quarterHourRule;

  function toggleQuarterHourRule(on: boolean) {
    updateAndSave({ ...appState, settings: { ...appState.settings, quarterHourRule: on } });
  }
  const enabledFeeds = appState.feeds.filter((f) => f.enabled);

  // Pool = all episodes from enabled feeds that have loaded successfully
  // Blocked episodes are removed at the source, so they are absent from the
  // shuffle, the spread list and the varied mix alike.
  const blockedIds = useMemo(() => new Set(loadBlocked()), []);
  const pool: Episode[] = enabledFeeds
    .flatMap((f) => {
      const status = feedStatuses[f.id];
      return status?.episodes ?? [];
    })
    .filter((e) => !blockedIds.has(e.id));

  const canStart = enabledFeeds.length > 0 && pool.length > 0;

  // Fetch / load feeds whenever enabled feeds change
  useEffect(() => {
    const enabled = appState.feeds.filter((f) => f.enabled);
    for (const feed of enabled) {
      // Already loaded — skip re-fetch
      const existing = feedStatuses[feed.id];
      if (existing && !existing.loading) continue;

      // Mark as loading
      setFeedStatuses((prev) => ({
        ...prev,
        [feed.id]: { loading: true, episodeCount: null, error: null, episodes: [] },
      }));

      (async () => {
        try {
          const resp = await fetch(`/api/relay?url=${encodeURIComponent(feed.url)}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const xml = await resp.text();
          cacheFeedXml(feed.id, xml);
          const parsed = parseFeedXml(xml, feed.id);
          setFeedStatuses((prev) => ({
            ...prev,
            [feed.id]: {
              loading: false,
              episodeCount: parsed.episodes.length,
              error: null,
              episodes: parsed.episodes,
              artwork: parsed.artwork,
            },
          }));
        } catch (err) {
          // Try cache fallback
          const cached = getCachedFeedXml(feed.id);
          if (cached) {
            const parsed = parseFeedXml(cached, feed.id);
            setFeedStatuses((prev) => ({
              ...prev,
              [feed.id]: {
                loading: false,
                episodeCount: parsed.episodes.length,
                error: null,
                episodes: parsed.episodes,
                artwork: parsed.artwork,
              },
            }));
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            setFeedStatuses((prev) => ({
              ...prev,
              [feed.id]: { loading: false, episodeCount: null, error: msg, episodes: [] },
            }));
          }
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appState.feeds]);

  function updateAndSave(next: AppState) {
    setAppState(next);
    saveState(next);
  }

  function toggleFeed(id: string) {
    const next: AppState = {
      ...appState,
      feeds: appState.feeds.map((f) =>
        f.id === id ? { ...f, enabled: !f.enabled } : f
      ),
    };
    updateAndSave(next);
  }

  function setSkipIntro(id: string, minutes: number) {
    const next: AppState = {
      ...appState,
      feeds: appState.feeds.map((f) =>
        f.id === id ? { ...f, skipIntroMin: minutes } : f
      ),
    };
    updateAndSave(next);
  }

  function selectTimer(minutes: number) {
    setTimerTouched(true);
    const next: AppState = {
      ...appState,
      settings: { ...appState.settings, timerMinutes: minutes },
    };
    updateAndSave(next);
    setCustomMinutes("");
  }

  function handleCustomMinutes(value: string) {
    setTimerTouched(true);
    setCustomMinutes(value);
    const n = Number(value);
    if (n >= 1) {
      const next: AppState = {
        ...appState,
        settings: { ...appState.settings, timerMinutes: n },
      };
      updateAndSave(next);
    }
  }

  function handleAddCustomFeed() {
    setCustomError(null);
    try {
      const next = addCustomFeed(appState, customUrl.trim(), customTitle.trim() || undefined);
      updateAndSave(next);
      setCustomUrl("");
      setCustomTitle("");
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleRemoveFeed(id: string) {
    const next = removeCustomFeed(appState, id);
    updateAndSave(next);
  }

  function startWith(chosen: Episode[], wasVaried = false) {
    const skipIntroByFeedId: Record<string, number> = {};
    const feedTitles: Record<string, string> = {};
    const artworkByFeedId: Record<string, string> = {};
    for (const f of appState.feeds) {
      if (f.skipIntroMin > 0) skipIntroByFeedId[f.id] = f.skipIntroMin;
      feedTitles[f.id] = f.title;
      const artwork = feedStatuses[f.id]?.artwork;
      if (artwork) artworkByFeedId[f.id] = artwork;
    }
    onStart(chosen, timerMinutes, skipIntroByFeedId, feedTitles, artworkByFeedId, leadRef.current, wasVaried, leadPositionRef.current);
    leadRef.current = null;
  }

  // There is no separate "Sleep" button any more, and there shouldn't be:
  // handleGolden did everything the old handleStart did — startWith(pool) —
  // and additionally enabled a feed when none were on and defaulted the timer.
  // Two buttons where one strictly contains the other is a decision with no
  // information in it.

  // Golden path: one tap to sleeping. Always goes through the pending flag —
  // enabling a feed / setting the timer only lands on the next render, and the
  // pool may still be fetching — so the effect below starts playback once both
  // the saved state and the pool are ready.
  function beginNight(lead: Episode | null, leadPosition = 0) {
    if (goldenPending) return;
    // Nothing to play means nothing to wait for. Without this the pending flag
    // latches on forever when feeds fail to load: the moon reads "tucking you
    // in…" and is disabled, and so is every other way to start a night.
    if (pool.length === 0) {
      setFeedError("couldn't reach your feeds — check your connection and try again");
      return;
    }
    leadRef.current = lead;
    leadPositionRef.current = leadPosition;
    let next = appState;
    if (!next.feeds.some((f) => f.enabled)) {
      next = {
        ...next,
        feeds: next.feeds.map((f) => (f.id === "swm" ? { ...f, enabled: true } : f)),
      };
    }
    if (!timerTouched) {
      next = { ...next, settings: { ...next.settings, timerMinutes: 45 } };
      setCustomMinutes("");
    }
    if (next !== appState) updateAndSave(next);
    setGoldenPending(true);
  }
  function handleGolden() {                                 // same shows, on shuffle
    if (lastEpisode) beacon("ritual_same_shows");           // (only a "ritual" for returners)
    beginNight(null);
  }
  // Where the listener drifted off in that episode, if it is worth returning
  // to. Read once: this screen is not live while a night runs.
  const lastEpisodePosition = useMemo(
    () => (lastEpisode ? (loadPositions()[lastEpisode.id] ?? 0) : 0),
    [lastEpisode?.id],
  );

  // Searching the pool means a result is always something we can actually
  // start — the same episodes the moon would have shuffled.
  // Component-scope feed titles. startWith() builds its own local `feedTitles`
  // for the onStart payload; referencing that one from JSX was a ReferenceError
  // that blanked the app as soon as a search returned a result.
  const feedTitleById = useMemo(
    () => Object.fromEntries(appState.feeds.map((f) => [f.id, f.title])),
    [appState.feeds],
  );

  const results = useMemo(
    () => (query.trim() ? searchEpisodes(pool, query, 8) : []),
    [query, pool],
  );

  function handleSearchPick(ep: Episode) {
    // Resume where they drifted off in that episode, exactly as "the exact one
    // again" does — finding a story you half-finished is the main reason to
    // search for it.
    beginNight(ep, loadPositions()[ep.id] ?? 0);
  }

  function handleExactAgain() {                             // the exact one again
    beacon("ritual_exact_again");
    beginNight(lastEpisode, lastEpisodePosition);
  }

  function handleExactAgainFromStart() {
    beacon("ritual_exact_again");
    beginNight(lastEpisode, 0);
  }

  // "sleep well?" is a kindness that also self-labels the detector; a confirmed
  // false positive (we thought you slept, you didn't) tightens it for next time.
  function handleSleepLabel(kind: "slept" | "awake") {
    if (!greetNight) return;
    beacon(kind === "slept" ? "slept_yes" : "slept_no");
    setSelfLabel(greetNight.startedAt, kind);
    if (kind === "awake" && greetNight.sleptAtMs !== null) {
      const p = loadParams();
      if (p) saveParams(tightenAfterFalsePositive(p));
    }
    setGreetNight(null);
  }

  useEffect(() => {
    if (!goldenPending || !canStart) return;
    setGoldenPending(false);
    startWith(pool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goldenPending, canStart]);

  // Semantic "varied night": embed candidate titles (MiniLM in-browser,
  // cached), pick VARIED_N spread across the embedding space, sleep on those.
  async function handleVariedStart() {
    if (!canStart || variedBusy) return;
    beacon("ritual_mix");
    setVariedBusy(true);
    setVariedNote("warming up…");
    // Bound the work before it starts: a full pool can be thousands of
    // titles — minutes of serial embedding on a phone. Spread it down to
    // EMBED_CAP candidates by feed×year first; the semantic pick then only
    // has to sort the finalists.
    const candidates = pool.length > EMBED_CAP ? diverseByMeta(pool, EMBED_CAP) : pool;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { embedTexts } = await import("@/lib/semantic-model");
      const work = (async () => {
        const vecs = await embedTexts(
          candidates.map((e) => e.title),
          (done, total) => setVariedNote(`reading titles… ${done}/${total}`),
          (pct) => setVariedNote(`fetching the mixer… ${pct}%`)
        );
        return diversePick(vecs, VARIED_N).map((i) => candidates[i]);
      })();
      work.catch(() => {}); // raced below; a late loss must not surface as unhandled
      // Slow devices still get their night: past the deadline we stop
      // waiting and take the meta spread instead of hanging on "mixing…".
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(new Error("semantic deadline")), 25_000);
      });
      startWith(await Promise.race([work, deadline]), true);
    } catch {
      // Semantic model can't run on every device (iOS Lockdown Mode blocks
      // WASM SIMD) — or didn't finish in time. Fall back to feed×year
      // spread — still varied, just not meaning-aware — and start anyway.
      startWith(diverseByMeta(pool, VARIED_N), true);
    } finally {
      clearTimeout(deadlineTimer);
      setVariedBusy(false);
    }
  }

  function feedStatusLabel(feed: FeedRef): string {
    const s = feedStatuses[feed.id];
    if (!feed.enabled) return "";
    if (!s || s.loading) return "loading…";
    if (s.error) return `error: ${s.error}`;
    if (s.episodeCount !== null) return `${s.episodeCount} episodes`;
    return "";
  }

  const isPreset = FEEL_PRESETS.some((p) => p.minutes === timerMinutes);

  const poolNote = pool.length > 0 ? `${pool.length} episodes ready` : "gathering episodes…";

  return (
    // The bedside register: amber on near-black, the same palette as the moon
    // screen the Player already uses. Not the marketing palette — this is read
    // by a face in a dark room, where #e9e6df off-white is simply too blue.
    // The page owns the background (app.astro); this just lays out inside it.
    <div className="text-[#b59a76]">
      <div className="mx-auto max-w-lg">
        {/* The field: one decision, in the thumb's arc. The moon IS the button —
            it's the same moon the Player veils the countdown behind, so the
            object you tap to fall asleep is the object holding the time you're
            not allowed to see. */}
        <div className="flex min-h-[82vh] flex-col items-center justify-center gap-6">
          {(lastEpisode || greetNight) && (
            <div className="w-full max-w-xs space-y-4 text-center">
              <p className="text-lg text-[#f0dcb8]">welcome back.</p>
              {greetNight && (
                <div className="text-sm text-[#8a7a5c]">
                  sleep well?
                  <span className="ml-3 inline-flex gap-2">
                    <button onClick={() => handleSleepLabel("slept")} className="rounded-full border border-[#3a3325] px-3 py-1 transition-colors hover:border-[#6e5d44]">yes</button>
                    <button onClick={() => handleSleepLabel("awake")} className="rounded-full border border-[#3a3325] px-3 py-1 transition-colors hover:border-[#6e5d44]">no</button>
                  </span>
                </div>
              )}
              {lastEpisode && (
                <button
                  onClick={handleExactAgain}
                  disabled={goldenPending}
                  className="w-full rounded-xl border border-[#3a3325] bg-[#171310] px-4 py-3 text-sm text-[#d9c9a8] transition-colors hover:border-[#6e5d44] disabled:opacity-50"
                >
                  ↻ the exact one again
                  <span className="mt-0.5 block truncate text-xs text-[#8a7a5c]">{lastEpisode.title}</span>
                  {lastEpisodePosition > 0 && (
                    <span className="mt-0.5 block text-xs text-[#6e5d44]">
                      from where you drifted · {formatTime(lastEpisodePosition)} in
                    </span>
                  )}
                </button>
              )}
              {lastEpisode && lastEpisodePosition > 0 && (
                <button
                  onClick={handleExactAgainFromStart}
                  disabled={goldenPending}
                  className="w-full text-center text-xs text-[#4a4540] underline decoration-[#2a2620] underline-offset-4 transition-colors hover:text-[#8a7a5c] disabled:opacity-50"
                >
                  or from the start
                </button>
              )}
              {pool.length > 0 && (
                <div>
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="or find one — “train”, “rain”…"
                    aria-label="search your episodes"
                    className="w-full rounded-xl border border-[#241f30] bg-[#12101a] px-4 py-3 text-sm text-[#b59a76] placeholder:text-[#4a4540] focus:border-[#6e5d44] focus:outline-none"
                  />
                  {query.trim() && (
                    <div className="mt-2 space-y-1">
                      {results.length === 0 ? (
                        <p className="px-1 text-xs text-[#4a4540]">nothing by that name</p>
                      ) : (
                        results.map((ep) => (
                          <button
                            key={ep.id}
                            onClick={() => handleSearchPick(ep)}
                            disabled={goldenPending}
                            className="block w-full truncate rounded-lg px-3 py-2 text-left text-sm text-[#b0a898] transition-colors hover:bg-[#171310] disabled:opacity-50"
                          >
                            {ep.title}
                            <span className="ml-2 text-xs text-[#4a4540]">
                              {feedTitleById[ep.feedId] ?? ""}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              {feedError && <p className="text-xs text-[#b3746b]">{feedError}</p>}
              <p className="text-xs text-[#6e5d44]">or the moon below — the same shows, on shuffle ↓</p>
            </div>
          )}
          <p className="text-xs text-[#6e5d44] tracking-wide">{poolNote}</p>

          <button
            onClick={handleGolden}
            disabled={goldenPending}
            aria-label="sleep"
            className="group relative grid h-52 w-52 place-items-center rounded-full disabled:cursor-wait"
          >
            <span
              aria-hidden="true"
              className="setup-moon-glow pointer-events-none absolute -inset-8 rounded-full [background:radial-gradient(circle,rgba(240,220,184,0.13)_0%,rgba(240,220,184,0)_68%)]"
            />
            <span
              aria-hidden="true"
              className="setup-moon select-none text-[7.5rem] leading-none text-[#f0dcb8] [text-shadow:0_0_60px_rgba(240,220,184,0.35)] transition-transform group-active:scale-95"
            >
              ☾
            </span>
          </button>

          <p className="font-serif-display -mt-4 text-2xl text-[#f0dcb8]">
            {goldenPending ? "tucking you in…" : "Sleep"}
          </p>

          {/* The only other decision on this screen. */}
          <div className="flex gap-2">
            {FEEL_PRESETS.map((preset) => (
              <button
                key={preset.minutes}
                onClick={() => selectTimer(preset.minutes)}
                aria-pressed={timerMinutes === preset.minutes && isPreset}
                aria-label={`${preset.label} — ${preset.minutes} minutes`}
                className={`min-h-[2.9rem] rounded-lg border px-3 py-2 text-sm transition-colors ${
                  timerMinutes === preset.minutes && isPreset
                    ? "border-[#241f30] bg-[#12101a] text-[#f0dcb8]"
                    : "border-transparent text-[#6e5d44] hover:text-[#b59a76]"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* The mix: a clear second way to start, one step down from the moon.
              A real button now, not a whispered link — people reach for it. */}
          <button
            onClick={handleVariedStart}
            disabled={!canStart || variedBusy || pool.length <= VARIED_N}
            title="Picks a mix of 8 episodes spread across different topics"
            className="mt-1 inline-flex items-center gap-2 rounded-full border border-[#3a3325] bg-[#12101a] px-5 py-2.5 text-sm text-[#d9c9a8] transition-colors hover:border-[#6e5d44] active:scale-95 disabled:opacity-40"
          >
            <span aria-hidden="true">🎲</span>
            {variedBusy ? (variedNote || "mixing your night…") : "a varied mix — 8 different shows"}
          </button>
        </div>

        {/* Everything below is the active work — choosing feeds, pasting URLs,
            fiddling with minutes. That's what asks you to think at 2am, so it
            waits behind a pull. The old screen put three start buttons and a
            feed editor in front of someone who just wanted to sleep. */}
        <details className="group pb-16">
          <summary className="mx-auto flex cursor-pointer list-none flex-col items-center gap-1.5 py-4 text-xs text-[#6e5d44] transition-colors hover:text-[#b59a76] [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="h-[3px] w-9 rounded-full bg-[#241f30] group-open:bg-[#6e5d44]" />
            <span>your feeds &amp; timer</span>
          </summary>

          <div className="space-y-8 pt-2">
        {/* Feeds */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-[#6e5d44]">Feeds</h2>
          <div className="space-y-2">
            {appState.feeds.map((feed) => {
              const label = feedStatusLabel(feed);
              const isError = feedStatuses[feed.id]?.error != null;
              return (
                <div
                  key={feed.id}
                  className="flex items-center gap-3 rounded-lg bg-[#12101a] border border-[#241f30] px-4 py-3"
                >
                  <input
                    type="checkbox"
                    id={`feed-${feed.id}`}
                    checked={feed.enabled}
                    onChange={() => toggleFeed(feed.id)}
                    className="h-5 w-5 rounded accent-[#6e5d44] cursor-pointer"
                  />
                  <label
                    htmlFor={`feed-${feed.id}`}
                    className="flex-1 cursor-pointer text-sm"
                  >
                    {feed.title}
                  </label>
                  {label && (
                    <span
                      className={`text-xs ${isError ? "text-red-400/70" : "text-[#6e5d44]"}`}
                    >
                      {label}
                    </span>
                  )}
                  {/* Skip intro */}
                  <div className="flex items-center gap-1 text-xs text-[#6e5d44]">
                    <label htmlFor={`skip-${feed.id}`} className="sr-only">
                      Skip intro minutes
                    </label>
                    <input
                      id={`skip-${feed.id}`}
                      type="number"
                      min={0}
                      max={60}
                      value={feed.skipIntroMin || ""}
                      placeholder="0"
                      onChange={(e) =>
                        setSkipIntro(feed.id, Math.max(0, Number(e.target.value) || 0))
                      }
                      className="w-12 rounded bg-[#12101a] border border-[#241f30] px-2 py-1 text-center text-[#b59a76] text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      title="Skip intro (minutes)"
                    />
                    <span>min skip</span>
                  </div>
                  {!feed.builtin && (
                    <button
                      onClick={() => handleRemoveFeed(feed.id)}
                      className="text-xs text-[#6e5d44] hover:text-red-400/70 ml-1"
                      aria-label={`Remove ${feed.title}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add custom feed */}
          <div className="rounded-lg bg-[#12101a] border border-[#241f30] px-4 py-3 space-y-2">
            <p className="text-xs text-[#6e5d44] uppercase tracking-widest">
              Add custom feed
            </p>

            {/* In-app on-ramp for non-technical listeners: the hard part isn't
                sleepcast, it's finding the private RSS link the paid service
                hands its subscribers. Native <details> — no JS, accessible. */}
            <details className="text-xs">
              <summary className="cursor-pointer list-none text-[#8a7a5c] transition-colors hover:text-[#b59a76] [&::-webkit-details-marker]:hidden">
                How do I add a paid show? →
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed text-[#8a7a5c]">
                <p>
                  Paid podcasts give subscribers a <strong>private RSS link</strong>.
                  Find it, copy it, paste it above — once. It's saved on this
                  device from then on.
                </p>
                <ul className="list-disc space-y-1.5 pl-4">
                  <li>
                    <span className="text-[#b59a76]">Sleep With Me Plus / Supercast:</span>{" "}
                    in Supercast, open “Listening links” or “Add to other apps”, then
                    <strong> Copy RSS feed</strong>.
                  </li>
                  <li>
                    <span className="text-[#b59a76]">Patreon:</span> the creator's page →
                    Membership → “Listen on other apps” / Get RSS link → <strong>Copy</strong>.
                  </li>
                  <li>
                    <span className="text-[#b59a76]">Apple Podcasts subscriptions:</span>{" "}
                    usually locked to Apple and can't be exported — check if the show
                    also offers Patreon or Supercast.
                  </li>
                </ul>
                <p>
                  The link is a long web address ending in <code>.rss</code>,{" "}
                  <code>.xml</code>, or <code>?feed=…</code>. Nothing you paste is
                  logged or stored.
                </p>
                <a
                  href="/help/"
                  className="inline-block underline decoration-[#3a3325] underline-offset-4 transition-colors hover:text-[#b59a76]"
                >
                  Full guide →
                </a>
              </div>
            </details>

            <input
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="Paste your private feed link (https://…)"
              className="w-full rounded bg-[#12101a] border border-[#241f30] px-3 py-2 text-sm text-[#b59a76] placeholder:text-[#6e5d44] focus:outline-none focus:border-[#6e5d44]"
            />
            <input
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="Title (optional)"
              className="w-full rounded bg-[#12101a] border border-[#241f30] px-3 py-2 text-sm text-[#b59a76] placeholder:text-[#6e5d44] focus:outline-none focus:border-[#6e5d44]"
            />
            {customError && (
              <p className="text-xs text-red-400/70">{customError}</p>
            )}
            <button
              onClick={handleAddCustomFeed}
              disabled={!customUrl.trim()}
              className="w-full rounded bg-[#12101a] border border-[#241f30] py-2 text-sm text-[#b59a76] disabled:opacity-40 hover:border-[#6e5d44] transition-colors"
            >
              Add feed
            </button>
          </div>
        </section>

        {/* A custom timer is the long tail of the one decision the field
            already offers, so it lives down here with the other fiddling. */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-[#6e5d44]">Custom timer</h2>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              value={customMinutes || (!isPreset ? timerMinutes : "")}
              placeholder="minutes"
              onChange={(e) => handleCustomMinutes(e.target.value)}
              className="w-28 rounded-lg bg-[#12101a] border border-[#241f30] px-3 py-3 text-base text-[#b59a76] placeholder:text-[#6e5d44] text-center focus:outline-none focus:border-[#6e5d44] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              aria-label="Custom timer minutes"
            />
            <p className="text-xs text-[#6e5d44]">
              now {timerMinutes} min — volume fades over the final 60 s
            </p>
          </div>
        </section>

        {/* Stimulus control, off unless asked for. It can stop a night early,
            so it is never on by default and never inferred. */}
        <section className="space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-[#6e5d44]">The quarter-hour rule</h2>
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={quarterHourRule}
              onChange={(e) => toggleQuarterHourRule(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[#6e5d44]"
            />
            <span className="text-xs text-[#6e5d44]">
              If you're still restless after 25 minutes, stop and suggest getting
              up for a while. Lying awake in bed teaches your bed to mean
              lying awake. Off by default — it can end a night early.
            </span>
          </label>
        </section>
          </div>
        </details>
      </div>
    </div>
  );
}
