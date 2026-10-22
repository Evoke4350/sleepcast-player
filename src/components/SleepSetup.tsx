import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, FeedRef } from "../lib/store";
import { loadBlocked, loadPositions, clampTimerMinutes, TIMER_MIN, TIMER_MAX } from "../lib/store";
import { parseOpml, buildOpml } from "../lib/opml";
import { isYouTubeUrl } from "../lib/web-cleanup";
import { rearmMinutes } from "../lib/engine";
import type { PlayMode } from "../lib/engine";
import {
  loadState,
  REARM_WINDOW_MS,
  saveState,
  addCustomFeed,
  removeCustomFeed,
  cacheFeedXml,
  getCachedFeedXml,
  loadLastEpisode,
  getPlays,
} from "../lib/store";
import { formatTime, parseFeedXml } from "../lib/engine";
import { beacon } from "../lib/beacon";
import type { Episode } from "../lib/engine";
import { loadNights, setSelfLabel } from "../lib/rest/ledger";
import { recordFalsePositive } from "../lib/rest/calibrate";
import { rankedFeeds, evidenceFor, fmtOnsetMinutes } from "../lib/rest/sleepscore";
import type { RestNight } from "../lib/rest/types";
import { TIMER_PRESETS } from "../lib/timer-presets";
import { learnedTimer, timedNights, handPickHolds, LEARN_MIN_NIGHTS } from "../lib/rest/learned-timer";
import { needsFetch } from "../lib/feed-status";
import { pickNextEpisode, HEARD_SEC } from "../lib/plays";
import { ShowGrid, ShowPage } from "./Shows";


interface FeedStatus {
  loading: boolean;
  episodeCount: number | null;
  error: string | null;
  episodes: Episode[];
  artwork?: string;
  /** When it last failed, for the retry backoff (see needsFetch). */
  failedAt?: number;
}

/** Which of the app's tabs this renders: the night (moon, timer), the shows,
 *  or the settings. One instance serves all three, so its state (feeds,
 *  statuses) survives switching between them. */
export type SetupTab = "sleep" | "podcasts" | "settings";

export interface SleepSetupProps {
  /** null: kept mounted (its state, the open show) but not shown. */
  tab: SetupTab | null;
  onStart: (
    pool: Episode[],
    timerMinutes: number,
    skipIntroByFeedId: Record<string, number>,
    feedTitles: Record<string, string>,
    artworkByFeedId: Record<string, string>,
    leadEpisode?: Episode | null,
    wasVaried?: boolean,
    leadPosition?: number,
    /** This night's mode when it differs from the saved setting (a re-arm). */
    modeOverride?: PlayMode
  ) => void;
}

/** One setting: a title, a line on what it does, and its switch. */
function SettingRow({ id, title, checked, disabled = false, onChange, children }: {
  id: string; title: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3.5">
      <label htmlFor={`setting-${id}`} className="space-y-0.5">
        <span className="block font-semibold text-[var(--ink)]">{title}</span>
        <span className="block text-[12.5px] leading-snug text-[var(--ink-3)]">{children}</span>
      </label>
      <button
        id={`setting-${id}`}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-[var(--accent)]" : "bg-[var(--raised)] ring-1 ring-inset ring-[var(--control)]"}`}
      >
        <span className={`absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-full shadow transition-transform ${checked ? "translate-x-5 bg-white" : "bg-[var(--control)]"}`} />
      </button>
    </div>
  );
}

/** A timer choice. */
function Pill({ on, onClick, label, children }: { on: boolean; onClick: () => void; label?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      className={`rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
        on ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--raised)] text-[var(--ink-2)] hover:text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

export function SleepSetup({ onStart, tab }: SleepSetupProps) {
  const [appState, setAppState] = useState<AppState>(() => loadState());
  const [opmlNote, setOpmlNote] = useState<string | null>(null);
  const [feedStatuses, setFeedStatuses] = useState<Record<string, FeedStatus>>({});
  const [customUrl, setCustomUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const addUrlRef = useRef<HTMLInputElement | null>(null);
  // Back from a show, focus goes to its tile rather than the top of the page.
  const returnToShowRef = useRef<string | null>(null);
  // A pasted @handle needs a server round trip before it is a feed.
  const [customMinutes, setCustomMinutes] = useState<string>("");
  const [goldenPending, setGoldenPending] = useState(false);
  // Returning-listener warmth: the show they drifted off to (for "the exact one
  // again"), and last night's record (to greet + ask how they slept, which
  // doubles as the detector's self-label).
  const leadRef = useRef<Episode | null>(null);
  const leadPositionRef = useRef(0);
  // A show whose episodes alone the next start shuffles (its page's
  // "Shuffle show"); null for every show that's on.
  const scopeRef = useRef<string | null>(null);
  // The show open on the Podcasts tab, if any.
  const [openShow, setOpenShow] = useState<string | null>(null);
  useEffect(() => {
    if (openShow || !returnToShowRef.current) return;
    document.querySelector<HTMLElement>(`[data-show-id="${CSS.escape(returnToShowRef.current)}"]`)?.focus();
    returnToShowRef.current = null;
  }, [openShow]);
  const addShowRef = useRef<HTMLDivElement | null>(null);
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

  // The timer learned from the nights (this screen is rebuilt after each,
  // so it reads the latest), and tonight's: the learned one, unless a timer
  // was picked by hand for tonight or learning is off.
  const [learned, timedSoFar] = useMemo(() => {
    const nights = loadNights();
    return [learnedTimer(nights), timedNights(nights)] as const;
  }, []);
  const learnOn = appState.settings.learnTimer !== false;
  const usingLearned = learnOn && learned !== null && appState.settings.mode.kind === "minutes" && !handPickHolds(appState.settings.timerPickedAt, Date.now());
  const timerMinutes = usingLearned && learned ? learned.minutes : appState.settings.timerMinutes;
  const quarterHourRule = appState.settings.quarterHourRule;

  /** An on/off setting, saved. */
  function setFlag(key: "quarterHourRule" | "favorWhatWorks" | "leveling", on: boolean) {
    updateAndSave({ ...appState, settings: { ...appState.settings, [key]: on } });
  }
  const enabledFeeds = appState.feeds.filter((f) => f.enabled);

  // Pool = all episodes from enabled feeds that have loaded successfully
  // Blocked episodes are removed at the source, so they are absent from the
  // shuffle and the spread list alike.
  const blockedIds = useMemo(() => new Set(loadBlocked()), []);
  const pool: Episode[] = enabledFeeds
    .flatMap((f) => {
      const status = feedStatuses[f.id];
      return status?.episodes ?? [];
    })
    .filter((e) => !blockedIds.has(e.id));

  const canStart = enabledFeeds.length > 0 && pool.length > 0;

  // Fetch every enabled feed that needs it (see needsFetch). `force` retries
  // failed feeds at once, for when the listener asks to try again. Takes the
  // feed list so a caller that just changed it can pass the new one before
  // the state update lands.
  function fetchFeeds(feeds: FeedRef[], force: boolean) {
    const now = Date.now();
    for (const feed of feeds.filter((f) => f.enabled)) {
      // In flight or loaded: leave it. Failed: retry if asked or rested.
      if (!needsFetch(feedStatuses[feed.id], now, force)) continue;

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
              [feed.id]: { loading: false, episodeCount: null, error: msg, episodes: [], failedAt: Date.now() },
            }));
          }
        }
      })();
    }
  }

  // Fetch / load feeds whenever enabled feeds change
  // One pass: the shows that are on, and on the Podcasts tab every show (its
  // artwork and count; the shuffle's pool still takes only those that are on).
  useEffect(() => {
    fetchFeeds(tab === "podcasts" ? appState.feeds.map((f) => ({ ...f, enabled: true })) : appState.feeds, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab === "podcasts", appState.feeds]);

  // A load that succeeds after "couldn't reach your feeds" clears the message.
  useEffect(() => {
    if (pool.length > 0) setFeedError("");
  }, [pool.length]);

  // An enabled feed with no status yet is about to be fetched, so it counts.
  function anyFeedLoading(): boolean {
    return enabledFeeds.some((f) => feedStatuses[f.id]?.loading ?? true);
  }

  // releaseStuckStart: a start that went pending while feeds were loading,
  // and then every one of them failed. Give up and say so, rather than leave
  // the moon disabled on "tucking you in…".
  useEffect(() => {
    if (!goldenPending || pool.length > 0 || anyFeedLoading()) return;
    setGoldenPending(false);
    leadRef.current = null;
    rearmNightRef.current = null;
    scopeRef.current = null;
    setFeedError("couldn't reach your feeds — check your connection and try again");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goldenPending, feedStatuses, appState.feeds]);

  function updateAndSave(next: AppState) {
    setAppState(next);
    saveState(next);
  }

  // A show opened while it's off still lists its episodes.
  function openShowPage(id: string) {
    setOpenShow(id);
    const feed = appState.feeds.find((f) => f.id === id);
    if (feed && !feed.enabled) fetchFeeds([{ ...feed, enabled: true }], false);
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

  function selectTimer(minutes: number) {
    const next: AppState = {
      ...appState,
      settings: {
        ...appState.settings,
        timerMinutes: minutes,
        timerPickedAt: Date.now(),
        // Picking a duration is picking minutes mode. Without this, choosing a
        // preset after "all night" would leave the mode timerless and the
        // number the listener just tapped would be quietly ignored.
        mode: { kind: "minutes", minutes },
      },
    };
    updateAndSave(next);
    setCustomMinutes("");
  }

  function handleCustomMinutes(value: string) {
    setCustomMinutes(value);
    const raw = Number(value);
    if (Number.isFinite(raw) && raw >= 1) {
      // Saved within range: a typo like 45000 would otherwise be a month-long
      // night, now that the saved timer is used as shown.
      const n = clampTimerMinutes(raw);
      const next: AppState = {
        ...appState,
        settings: {
          ...appState.settings,
          timerMinutes: n,
          timerPickedAt: Date.now(),
          mode: { kind: "minutes", minutes: n },
        },
      };
      updateAndSave(next);
    }
  }

  function addResolvedFeed(url: string) {
    try {
      const next = addCustomFeed(appState, url, customTitle.trim() || undefined);
      updateAndSave(next);
      setCustomUrl("");
      setCustomTitle("");
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAddCustomFeed() {
    setCustomError(null);
    const url = customUrl.trim();
    if (isYouTubeUrl(url)) {
      setCustomError("youtube isn't supported: paste a podcast's feed link.");
      return;
    }
    addResolvedFeed(url);
  }

  function handleRemoveFeed(id: string) {
    const next = removeCustomFeed(appState, id);
    updateAndSave(next);
  }

  const mode = appState.settings.mode;

  // Back to the learned timer: the hand pick, if any, let go.
  function selectLearned() {
    const { timerPickedAt: _, ...settings } = appState.settings;
    updateAndSave({ ...appState, settings: { ...settings, mode: { kind: "minutes", minutes: settings.timerMinutes } } });
    setCustomMinutes("");
  }

  function selectEpisodeMode(kind: "one-episode" | "all-night") {
    updateAndSave({
      ...appState,
      settings: { ...appState.settings, mode: { kind } },
    });
    setCustomMinutes("");
  }

  function handleOpmlImport(file: File) {
    setOpmlNote(null);
    file.text().then((xml) => {
      let entries;
      try {
        entries = parseOpml(xml);
      } catch {
        setOpmlNote("that file doesn't look like OPML");
        return;
      }
      // Re-read the persisted state rather than closing over the appState
      // captured when this handler started: file.text() above awaited, and
      // building from that stale snapshot would silently discard any toggle
      // made while the file was being read. loadState() is the source of
      // truth here.
      let next = loadState();
      let added = 0;
      let skipped = 0;
      for (const entry of entries) {
        const before = next.feeds.length;
        try {
          // Imported feeds start disabled — a 40-feed OPML would otherwise
          // fetch every one of them through /api/relay at once (feeds run
          // 0.6-8.8MB each).
          next = addCustomFeed(next, entry.url, entry.title ?? undefined, false);
        } catch {
          skipped++; // invalid / non-https URL
          continue;
        }
        if (next.feeds.length > before) added++;
        else skipped++; // duplicate URL
      }
      if (added > 0) updateAndSave(next);
      setOpmlNote(`added ${added} · skipped ${skipped} — enable the ones you want`);
    });
  }

  function handleOpmlExport() {
    const xml = buildOpml(appState.feeds.map((f) => ({ url: f.url, title: f.title })));
    const blob = new Blob([xml], { type: "text/x-opml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sleepcast-feeds.opml";
    a.click();
    // Revoking in the same tick as click() can race the browser's own
    // download handoff and cancel it — hold the URL alive a beat longer.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function startWith(picked: Episode[], wasVaried = false) {
    // Read afresh: an episode marked "never again" during a night (this
    // screen stays up through it) mustn't come back in the next.
    const blockedNow = new Set(loadBlocked());
    const chosen = picked.filter((e) => !blockedNow.has(e.id));
    if (leadRef.current && blockedNow.has(leadRef.current.id)) leadRef.current = null;
    // No skip-intro: the setting is gone, so none is sent (stored ones are
    // cleared on load, web-cleanup.ts).
    const skipIntroByFeedId: Record<string, number> = {};
    const feedTitles: Record<string, string> = {};
    const artworkByFeedId: Record<string, string> = {};
    for (const f of appState.feeds) {
      feedTitles[f.id] = f.title;
      const artwork = feedStatuses[f.id]?.artwork;
      if (artwork) artworkByFeedId[f.id] = artwork;
    }
    const rearm = rearmNightRef.current;
    rearmNightRef.current = null;
    onStart(
      chosen,
      rearm?.kind === "minutes" ? rearm.minutes : timerMinutes,
      skipIntroByFeedId, feedTitles, artworkByFeedId,
      leadRef.current, wasVaried, leadPositionRef.current,
      rearm ?? undefined,
    );
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
  // Set just before a re-arm triggers its own start, so beginNight can tell
  // "this start came from the offer, leave the stamp alone" from "an ordinary
  // start, clear it".
  const rearmStartRef = useRef(false);
  // A re-arm's timer and mode, carried to startWith for that one night rather
  // than saved over the listener's setting.
  const rearmNightRef = useRef<PlayMode | null>(null);

  // One tap back to sleep: half the previous dose, no setup steps.
  function handleRearm() {
    if (!rearmable || goldenPending) return;
    rearmStartRef.current = true;
    const nextMode: PlayMode =
      rearmable.modeKind === "one-episode"
        ? { kind: "one-episode" }
        : { kind: "minutes", minutes: rearmM };
    // For this night only. It used to be saved as the setting; once the
    // per-night reset to 45 was gone, a re-arm's halved dose became every
    // later night's timer (45, then 25, then 10...).
    rearmNightRef.current = nextMode;
    beginNight(null);
  }

  function beginNight(lead: Episode | null, leadPosition = 0) {
    if (goldenPending) {
      scopeRef.current = null;
      return;
    }
    // Nothing to play and nothing on its way means nothing to wait for:
    // pending would latch on forever, the moon reading "tucking you in…" and
    // disabled. That is only true once every enabled feed has finished. While
    // one is still loading, fall through and wait (the golden effect starts
    // the night when the pool fills; releaseStuckStart below gives up if they
    // all fail). With no feed enabled, fall through too: the default show is
    // turned on below. Both used to hit this early return and report a
    // network failure that hadn't happened.
    if (pool.length === 0 && enabledFeeds.length > 0 && !anyFeedLoading()) {
      setFeedError("couldn't reach your feeds — check your connection and try again");
      // "Try again" has to mean something: retry failed feeds now. Before,
      // they were only retried when the feed list changed, so tapping again
      // repeated this message forever.
      fetchFeeds(appState.feeds, true);
      // A re-arm (or one show's shuffle) that couldn't start must not carry
      // into the next ordinary one.
      scopeRef.current = null;
      rearmNightRef.current = null;
      rearmStartRef.current = false;
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
    // The timer is left as saved. It used to be reset to 45 unless touched
    // since page load, while the setup screen showed the saved choice as
    // selected: pick "a long while" last night, tap the moon tonight, and get
    // 45 minutes with nothing on screen saying so.
    if (!rearmStartRef.current && next.settings.lastSession !== null) {
      // Any ordinary start dismisses the offer for the rest of the window —
      // it should appear once, when it might help, and never nag.
      next = { ...next, settings: { ...next.settings, lastSession: null } };
    }
    rearmStartRef.current = false;
    if (next !== appState) updateAndSave(next);
    setGoldenPending(true);
  }
  function handleGolden() {                                 // same shows, on shuffle
    if (lastEpisode) beacon("ritual_same_shows");           // (only a "ritual" for returners)
    beginNight(null);
  }

  /** An episode from the suggested feed, chosen by the ordinary freshness
   *  rule. Returns null if the feed's episodes have not loaded yet, in which
   *  case beginNight(null) starts the night shuffled — the same as tapping
   *  the moon. */
  function leadFromFeed(feedId: string): Episode | null {
    const fromFeed = pool.filter((e) => e.feedId === feedId);
    return fromFeed.length ? pickNextEpisode(fromFeed, getPlays()) : null;
  }

  // Where the listener drifted off in that episode, if it is worth returning
  // to. Read once: this screen is not live while a night runs.
  const lastEpisodePosition = useMemo(
    () => (lastEpisode ? (loadPositions()[lastEpisode.id] ?? 0) : 0),
    [lastEpisode?.id],
  );

  // Read once. This screen is not live while a night runs, and re-ranking on
  // every render would let the suggestion change under the user's thumb.
  const suggestion = useMemo(() => {
    const nights = loadNights();
    for (const f of rankedFeeds(nights)) {
      const feed = appState.feeds.find((x) => x.id === f.feedId && x.enabled);
      if (feed) return { feed, line: evidenceFor(nights, f) };
    }
    return null;
  }, [appState.feeds]);

  // The card renders as soon as the suggested feed is known, but its
  // episodes may still be in flight — pool fills in per-feed as each fetch
  // resolves. If "start" fires before they arrive, leadFromFeed returns null
  // and beginNight(null) quietly shuffles: a user who tapped a button naming
  // one feed gets a different one with no indication anything changed.
  const suggestionReady = suggestion
    ? pool.some((e) => e.feedId === suggestion.feed.id)
    : false;

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
      recordFalsePositive();
    }
    setGreetNight(null);
  }

  useEffect(() => {
    if (!goldenPending || !canStart) return;
    setGoldenPending(false);
    // One show's shuffle (its page), or every show that's on (the moon).
    const scope = scopeRef.current;
    scopeRef.current = null;
    const scoped = scope ? (feedStatuses[scope]?.episodes ?? []).filter((e) => !blockedIds.has(e.id)) : [];
    startWith(scoped.length ? scoped : pool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goldenPending, canStart]);

  // A natural fade-out inside the last six hours means someone may have woken
  // back up. Offer half the previous dose, one tap, no setup.
  const lastSession = appState.settings.lastSession;
  const rearmable =
    lastSession !== null && Date.now() - lastSession.endedAt < REARM_WINDOW_MS
      ? lastSession
      : null;
  const rearmM = rearmable ? rearmMinutes(rearmable.timerMinutes) : 0;

  // Only a timed night has a duration to show as selected. In one-episode or
  // all-night mode the saved minutes still matched a preset, so it lit up
  // alongside the mode button and two choices looked active at once.
  const isPreset = mode.kind === "minutes" && !usingLearned && (TIMER_PRESETS as readonly number[]).includes(timerMinutes);
  // Offered as a disabled control with a reason rather than hidden: someone
  // who has read about the feature should find out why it isn't here, not
  // wonder whether they imagined it.
  const levelingUnavailable = typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

  const poolNote = pool.length > 0 ? `${pool.length} episodes ready` : "gathering episodes…";

  return (
    // The page owns the background (globals.css tokens); this lays out inside it.
    <div className="text-[var(--ink-2)]" hidden={tab === null}>
      <div className="mx-auto max-w-lg">
        {/* The field: one decision, in the thumb's arc. The moon IS the button —
            it's the same moon the Player veils the countdown behind, so the
            object you tap to fall asleep is the object holding the time you're
            not allowed to see. */}
        {tab === "sleep" && (
        <div className="flex min-h-[82vh] flex-col items-center justify-center gap-6">
          {(lastEpisode || greetNight) && (
            <div className="w-full max-w-xs space-y-4 text-center">
              <p className="text-lg text-[var(--ink)]">welcome back.</p>
              {greetNight && (
                <div className="text-sm text-[var(--ink-3)]">
                  sleep well?
                  <span className="ml-3 inline-flex gap-2">
                    <button onClick={() => handleSleepLabel("slept")} className="rounded-full border border-[var(--line)] px-3 py-1 transition-colors hover:border-[var(--ink-4)]">yes</button>
                    <button onClick={() => handleSleepLabel("awake")} className="rounded-full border border-[var(--line)] px-3 py-1 transition-colors hover:border-[var(--ink-4)]">no</button>
                  </span>
                </div>
              )}
              {lastEpisode && (
                <button
                  onClick={handleExactAgain}
                  disabled={goldenPending}
                  className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink)] transition-colors hover:border-[var(--ink-4)] disabled:opacity-50"
                >
                  ↻ the exact one again
                  <span className="mt-0.5 block truncate text-xs text-[var(--ink-3)]">{lastEpisode.title}</span>
                  {lastEpisodePosition > 0 && (
                    <span className="mt-0.5 block text-xs text-[var(--ink-4)]">
                      from where you drifted · {formatTime(lastEpisodePosition)} in
                    </span>
                  )}
                </button>
              )}
              {lastEpisode && lastEpisodePosition > 0 && (
                <button
                  onClick={handleExactAgainFromStart}
                  disabled={goldenPending}
                  className="w-full text-center text-xs text-[var(--ink-4)] underline decoration-[var(--line)] underline-offset-4 transition-colors hover:text-[var(--ink-3)] disabled:opacity-50"
                >
                  or from the start
                </button>
              )}
              {feedError && <p role="alert" className="text-xs text-[var(--danger)]">{feedError}</p>}
              <p className="text-xs text-[var(--ink-4)]">or the moon below — the same shows, on shuffle ↓</p>
            </div>
          )}
          <p className="text-xs text-[var(--ink-4)] tracking-wide">{poolNote}</p>

          {rearmable && !goldenPending && (
            <button
              onClick={handleRearm}
              className="w-full max-w-xs rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--ink-3)] transition-colors hover:text-[var(--ink-2)]"
            >
              still awake?{" "}
              {rearmable.modeKind === "one-episode"
                ? "one more episode"
                : `resume · ${rearmM} min`}
            </button>
          )}

          {/* Names one feed and the reason, so the pick is never asserted
              without the evidence beside it — and never without a one-tap
              refusal, since a suggestion that can't be waved off is a nag. */}
          {suggestion && (
            <div className="w-full max-w-xs rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-center">
              <p className="text-sm text-[var(--ink)]">
                {suggestion.feed.title} leads tonight.
              </p>
              <p className="mt-1 text-xs text-[var(--ink-3)]">{suggestion.line}</p>
              <div className="mt-3 flex justify-center gap-3 text-sm">
                <button
                  onClick={() => beginNight(leadFromFeed(suggestion.feed.id))}
                  disabled={goldenPending || !suggestionReady}
                  title={suggestionReady ? undefined : "still loading that feed's episodes…"}
                  className="rounded-full border border-[var(--ink-4)] px-4 py-1.5 text-[var(--ink)] transition-colors hover:border-[var(--ink-3)] disabled:opacity-50"
                >
                  start
                </button>
                <button
                  onClick={() => beginNight(null)}
                  disabled={goldenPending}
                  className="rounded-full border border-[var(--line)] px-4 py-1.5 text-[var(--ink-3)] transition-colors hover:border-[var(--ink-4)] disabled:opacity-50"
                >
                  something else
                </button>
              </div>
            </div>
          )}

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
              className="setup-moon select-none text-[7.5rem] leading-none text-[var(--accent)] [text-shadow:0_0_60px_rgba(240,220,184,0.35)] transition-transform group-active:scale-95"
            >
              ☾
            </span>
          </button>

          <p role="status" className="font-serif-display -mt-4 text-2xl text-[var(--ink)]">
            {goldenPending ? "tucking you in…" : "Sleep"}
          </p>

          {/* The only other decision on this screen: how long. Minutes, or
              one episode (fades when it ends), or all night (stopped by hand). */}
          <div className="w-full max-w-sm space-y-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
            <div className="flex items-baseline justify-between">
              <span className="font-semibold text-[var(--ink)]">Sleep timer</span>
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-4)]">fades at the end</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {learnOn && learned && (
                <Pill on={usingLearned} onClick={selectLearned} label={`Learned: ${learned.minutes} minutes`}>
                  Learned · {learned.minutes} min
                </Pill>
              )}
              {TIMER_PRESETS.map((minutes) => (
                <Pill key={minutes} on={timerMinutes === minutes && isPreset} onClick={() => selectTimer(minutes)} label={`${minutes} minutes`}>
                  {minutes} min
                </Pill>
              ))}
              <Pill on={mode.kind === "one-episode"} onClick={() => selectEpisodeMode("one-episode")}>One episode</Pill>
              <Pill on={mode.kind === "all-night"} onClick={() => selectEpisodeMode("all-night")}>All night</Pill>
            </div>
            {learnOn && (
              <p className="text-xs leading-snug text-[var(--ink-3)]">
                {!learned
                  ? `After ${LEARN_MIN_NIGHTS} timed nights the timer learns how long you take to fall asleep (${Math.min(timedSoFar, LEARN_MIN_NIGHTS)} so far).`
                  : usingLearned
                    ? `You're usually under in about ${fmtOnsetMinutes(learned.usualMs)}, so ${learned.minutes} min leaves room. From your last ${learned.nights} nights.`
                    : mode.kind === "minutes"
                      ? `Your pick for tonight. Tomorrow it's back to ${learned.minutes} min, learned.`
                      : `Learned from your nights: ${learned.minutes} min, when you want a timer.`}
              </p>
            )}
          </div>

        </div>
        )}
        {tab === "podcasts" && openShow && (() => {
          const feed = appState.feeds.find((f) => f.id === openShow);
          if (!feed) return null;
          const positions = loadPositions();
          const blockedNow = new Set(loadBlocked());
          const heard = new Set(getPlays().filter((p) => p.heardSec >= HEARD_SEC).map((p) => p.id));
          return (
            <ShowPage
              feed={feed}
              status={feedStatuses[feed.id] && { ...feedStatuses[feed.id], episodes: feedStatuses[feed.id].episodes.filter((e) => !blockedNow.has(e.id)) }}
              heard={heard}
              positions={positions}
              onBack={() => { returnToShowRef.current = feed.id; setOpenShow(null); }}
              onPlay={(ep) => beginNight(ep, positions[ep.id] ?? 0)}
              onShuffle={() => { scopeRef.current = feed.id; beginNight(null); }}
              onToggleShuffle={() => toggleFeed(feed.id)}
              onRemove={feed.builtin ? undefined : () => { handleRemoveFeed(feed.id); setOpenShow(null); }}
            />
          );
        })()}
        {tab === "podcasts" && !openShow && (
          <div className="space-y-8 pb-8">
        {/* Feeds */}
        <section className="space-y-3">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">Podcasts</h1>
          <ShowGrid
            feeds={appState.feeds}
            statuses={feedStatuses}
            onOpen={openShowPage}
            onAdd={() => {
              addShowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              addUrlRef.current?.focus({ preventScroll: true });
            }}
          />

          {/* Add custom feed */}
          <div ref={addShowRef} className="rounded-lg bg-[var(--surface)] border border-[var(--line)] px-4 py-3 space-y-2">
            <h2 className="text-xs text-[var(--ink-4)] uppercase tracking-widest">
              Add a show
            </h2>

            {/* In-app on-ramp for non-technical listeners: the hard part isn't
                sleepcast, it's finding the private RSS link the paid service
                hands its subscribers. Native <details> — no JS, accessible. */}
            <details className="text-xs">
              <summary className="cursor-pointer list-none text-[var(--ink-3)] transition-colors hover:text-[var(--ink-2)] [&::-webkit-details-marker]:hidden">
                How do I add a paid show? →
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed text-[var(--ink-3)]">
                <p>
                  Paid podcasts give subscribers a <strong>private RSS link</strong>.
                  Find it, copy it, paste it above — once. It's saved on this
                  device from then on.
                </p>
                <ul className="list-disc space-y-1.5 pl-4">
                  <li>
                    <span className="text-[var(--ink-2)]">Sleep With Me Plus / Supercast:</span>{" "}
                    in Supercast, open “Listening links” or “Add to other apps”, then
                    <strong> Copy RSS feed</strong>.
                  </li>
                  <li>
                    <span className="text-[var(--ink-2)]">Patreon:</span> the creator's page →
                    Membership → “Listen on other apps” / Get RSS link → <strong>Copy</strong>.
                  </li>
                  <li>
                    <span className="text-[var(--ink-2)]">Apple Podcasts subscriptions:</span>{" "}
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
                  className="inline-block underline decoration-[var(--line)] underline-offset-4 transition-colors hover:text-[var(--ink-2)]"
                >
                  Full guide →
                </a>
              </div>
            </details>

            <label htmlFor="add-show-url" className="block pt-1 text-xs font-semibold text-[var(--ink-2)]">Feed link</label>
            <input
              id="add-show-url"
              ref={addUrlRef}
              type="url"
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded bg-[var(--surface)] border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-2)] placeholder:text-[var(--ink-4)]"
            />
            <label htmlFor="add-show-title" className="block text-xs font-semibold text-[var(--ink-2)]">Title (optional)</label>
            <input
              id="add-show-title"
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="as it should appear"
              className="w-full rounded bg-[var(--surface)] border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-2)] placeholder:text-[var(--ink-4)]"
            />
            {customError && (
              <p role="alert" className="text-xs text-[var(--danger)]">{customError}</p>
            )}
            <button
              onClick={() => { void handleAddCustomFeed(); }}
              disabled={!customUrl.trim()}
              className="w-full rounded bg-[var(--surface)] border border-[var(--line)] py-2 text-sm text-[var(--ink-2)] disabled:opacity-40 hover:border-[var(--ink-4)] transition-colors"
            >
              Add feed
            </button>
            <div className="flex items-center justify-between pt-1 text-xs text-[var(--ink-4)]">
              <label className="cursor-pointer rounded underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-text)]">
                import OPML
                <input
                  type="file"
                  accept=".opml,.xml,text/xml,text/x-opml"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleOpmlImport(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={handleOpmlExport}
                className="underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]"
              >
                export OPML
              </button>
            </div>
            <p role="status" className="text-xs text-[var(--ink-4)] empty:hidden">{opmlNote ?? ""}</p>
          </div>
        </section>
          </div>
        )}
        {tab === "settings" && (
          <div className="space-y-4 pb-8">
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">Settings</h1>
            <div className="divide-y divide-[var(--line)] rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4">
              {/* The shuffle leaning on the sleep scores, off unless asked
                  for: a pool that narrows on its own is hard to notice going
                  wrong, so the listener chooses it knowingly, and off is the
                  plain shuffle to compare against (the scoring spec, §8). */}
              <SettingRow
                id="favor"
                title="Favour what puts me under"
                checked={appState.settings.favorWhatWorks}
                onChange={(on) => setFlag("favorWhatWorks", on)}
              >
                Shows you&apos;ve fallen asleep to come up a little more often, and ones you skip a little less. Each needs a few nights first, and nothing is ever ruled out.
              </SettingRow>
              <SettingRow
                id="learn-timer"
                title="Learn my timer"
                checked={learnOn}
                onChange={(on) => updateAndSave({ ...appState, settings: { ...appState.settings, learnTimer: on } })}
              >
                Sets tonight&apos;s timer from how long you&apos;ve taken to fall asleep lately, with room to spare. A timer you pick by hand holds for that night.
              </SettingRow>
              {/* Stimulus control, off unless asked for. It can stop a night
                  early, so it is never on by default and never inferred. */}
              <SettingRow
                id="quarter-hour"
                title="The quarter-hour rule"
                checked={quarterHourRule}
                onChange={(on) => setFlag("quarterHourRule", on)}
              >
                If you&apos;re still restless after 25 minutes, it stops and suggests getting up for a while (stimulus control, from CBT-I): lying awake in bed teaches the bed to mean lying awake. A suggestion, not treatment.
              </SettingRow>
              <SettingRow
                id="leveling"
                title="Even out loudness"
                checked={appState.settings.leveling}
                disabled={levelingUnavailable}
                onChange={(on) => setFlag("leveling", on)}
              >
                {levelingUnavailable
                  ? "Not on iPhone or iPad: it routes audio through Web Audio, which these suspend when the screen locks, and the night would go silent."
                  : "Quiet and loud shows play at about the same level. Costs an extra load on each show's first episode."}
              </SettingRow>
              {/* A custom timer is the long tail of the timer presets. */}
              <div className="flex items-center justify-between gap-4 py-3.5">
                <label htmlFor="custom-minutes" className="space-y-0.5">
                  <span className="block font-semibold text-[var(--ink)]">Custom timer</span>
                  <span className="block text-[12.5px] text-[var(--ink-3)]">
                    {mode.kind === "minutes" ? `Now ${timerMinutes} min. The last 60 s fade to silence.` : "Minutes, between the presets or past them."}
                  </span>
                </label>
                <input
                  id="custom-minutes"
                  type="number"
                  min={TIMER_MIN}
                  max={TIMER_MAX}
                  value={customMinutes || (mode.kind === "minutes" && !isPreset && !usingLearned ? timerMinutes : "")}
                  placeholder="min"
                  onChange={(e) => handleCustomMinutes(e.target.value)}
                  // Saved values are clamped (3 saves 5, 600 saves 480). While
                  // typing, the box keeps what's typed so "3" can become "30";
                  // on leaving it, it shows what was actually saved.
                  onBlur={() => setCustomMinutes("")}
                  className="w-20 rounded-lg border border-[var(--line)] bg-[var(--raised)] px-2 py-2 text-center text-base text-[var(--ink)] placeholder:text-[var(--ink-4)] focus:border-[var(--accent)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  aria-label="Custom timer minutes"
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-3.5">
                <span className="space-y-0.5">
                  <span className="block font-semibold text-[var(--ink)]">Appearance</span>
                  <span className="block text-[12.5px] text-[var(--ink-3)]">Light or dark, as your phone is set.</span>
                </span>
              </div>
            </div>
            <div className="pt-1 text-center">
              <a href="/privacy" className="text-xs text-[var(--ink-4)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-3)]">Privacy and analytics</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
