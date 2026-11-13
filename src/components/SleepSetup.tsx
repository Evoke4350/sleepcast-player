import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppState, FeedRef } from "../lib/store";
import { loadBlocked, loadPositions, loadKeepLatest, saveKeepLatest, clampTimerMinutes, TIMER_MIN, TIMER_MAX } from "../lib/store";
import { OfflineAudio } from "../lib/offline-audio";
import { latestToKeep, loadManualSaves, pinnedUrls, toggleManualSave } from "../lib/keep-latest";
import { useLazyRef } from "../lib/use-lazy-ref";
import { parseOpml, buildOpml } from "../lib/opml";
import { downloadBackup, parseBackup, restoreBackup, summarizeStored } from "../lib/backup";
import { downloadFile } from "../lib/download";
import { keepStorage, lastBackedUpAt, storageKept } from "../lib/keep";
import type { Backup, BackupSummary } from "../lib/backup";
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
import { rankedFeeds, evidenceFor, fmtOnsetMinutes, pluralNights } from "../lib/rest/sleepscore";
import type { RestNight } from "../lib/rest/types";
import { TIMER_PRESETS } from "../lib/timer-presets";
import { learnedTimer, timedNights, handPickHolds, LEARN_MIN_NIGHTS } from "../lib/rest/learned-timer";
import { importWatchSleep, describeImport } from "../lib/rest/watch";
import { currentExperiment, assignTonight, experimentResult } from "../lib/rest/experiment";
import { keptTimer, dropKeptTimer } from "../lib/rest/kept-timer";
import { needsFetch } from "../lib/feed-status";
import { pickNextEpisode, HEARD_SEC } from "../lib/plays";
import { JumpBackIn, Library, ShowArt, ShowPage } from "./Shows";
import { jumpBackIn, lastPlayedByFeed } from "../lib/library";
import { ShowCatalog } from "./Catalog";
import { FindShow } from "./FindShow";
import type { FoundShow } from "../lib/podcast-search";
import { CATALOG, CATALOG_STYLES, isAdded, type CatalogShow } from "../lib/catalog";


interface FeedStatus {
  loading: boolean;
  episodeCount: number | null;
  error: string | null;
  episodes: Episode[];
  artwork?: string;
  author?: string;
  about?: string;
  notes?: Record<string, string>;
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
  /** A night is playing (the show page's "Play next" says so). */
  nightLive?: boolean;
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
/** A settings group: a heading over a card of rows, as on a phone's own
 *  settings screen. */
function Group({ id, title, children, padded = false }: { id: string; title: string; children: React.ReactNode; padded?: boolean }) {
  return (
    <section aria-labelledby={`group-${id}`} className="space-y-2">
      <h2 id={`group-${id}`} className="px-1 text-lg font-bold tracking-tight text-[var(--ink)]">{title}</h2>
      <div className={`rounded-2xl bg-[var(--surface)] ring-1 ring-[var(--line)] ${padded ? "space-y-3 p-4" : "divide-y divide-[var(--line)] px-4"}`}>{children}</div>
    </section>
  );
}

/** A row's icon: a small tile, so the rows scan by shape before words. */
function RowIcon({ d }: { d: string }) {
  return (
    <span aria-hidden="true" className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--raised)] text-[var(--accent-text)]">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]"><path d={d} /></svg>
    </span>
  );
}

const ICONS = {
  favor: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  learn: "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  custom: "M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9",
  saveAhead: "M12 4v11M7 10l5 5 5-5M5 20h14",
  appearance: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18zM12 3v18M12 7h4M12 11h5M12 15h4",
  privacy: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
};

function SettingRow({ id, title, icon, checked, disabled = false, onChange, children }: {
  id: string; title: string; icon: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5">
      <RowIcon d={icon} />
      <label htmlFor={`setting-${id}`} className="flex-1 space-y-0.5">
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

function fmtBackupDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function describeSummary({ feeds, nights }: BackupSummary): string {
  return `${feeds} ${feeds === 1 ? "feed" : "feeds"}, ${nights} ${nights === 1 ? "night" : "nights"}`;
}

/** A timer choice. */
function Pill({ on, onClick, label, children }: { on: boolean; onClick: () => void; label?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      className={`rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
        on ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[color-mix(in_srgb,var(--surface)_65%,transparent)] text-[var(--ink)] ring-1 ring-[var(--line)] hover:bg-[var(--surface)]"
      }`}
    >
      {children}
    </button>
  );
}

export function SleepSetup({ onStart, tab, nightLive = false }: SleepSetupProps) {
  const [appState, setAppState] = useState<AppState>(() => loadState());
  const [opmlNote, setOpmlNote] = useState<string | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ backup: Backup; summary: BackupSummary } | null>(null);
  const [backedUpAt, setBackedUpAt] = useState<number | null>(() => lastBackedUpAt());
  const [kept, setKept] = useState(false);
  // Setup stays mounted across tabs, and the Rest tab can save a backup:
  // read both afresh each time Settings opens.
  useEffect(() => {
    if (tab !== "settings") return;
    setBackedUpAt(lastBackedUpAt());
    void storageKept().then(setKept);
  }, [tab]);
  const replaceBtnRef = useRef<HTMLButtonElement>(null);
  const [watchNote, setWatchNote] = useState<{ text: string; error: boolean } | null>(null);
  const [feedStatuses, setFeedStatuses] = useState<Record<string, FeedStatus>>({});
  const [customUrl, setCustomUrl] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const addUrlRef = useRef<HTMLInputElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
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
  const addShowRef = useRef<HTMLElement | null>(null);
  const catalogRef = useRef<HTMLHeadingElement | null>(null);
  const [feedError, setFeedError] = useState("");
  const [lastEpisode] = useState(() => loadLastEpisode());
  const [greetNight, setGreetNight] = useState<RestNight | null>(() => {
    const last = loadNights().at(-1) ?? null;
    // A night the watch measured needs no asking.
    // A night a quick restart left undecided is asked about too (rest/restart.ts).
    return last && (last.sleptAtMs !== null || last.restartedAfter) && last.selfLabel === undefined && last.detector !== "hr" ? last : null;
  });

  // A returning listener saw the welcome — fire once. (Aggregate, no PII.)
  useEffect(() => {
    if (lastEpisode || greetNight) beacon("welcome_shown");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The timer learned from the nights, and "your timer" (kept-timer.ts, an
  // experiment's winner you kept), read again on coming to this tab (an
  // experiment ends on Rest). Tonight's is your timer, else the learned one
  // if learning is on, unless a timer was picked by hand for tonight.
  const [keptRead, rereadKept] = useReducer((n: number) => n + 1, 0);
  // The show page reads played, positions and blocked fresh each render;
  // its sheet changes them, then asks for another.
  const [, redrawShows] = useReducer((n: number) => n + 1, 0);
  // Episodes kept on the device ahead of any night (keep-latest.ts): each
  // show's latest few, and any saved by hand. The keeper pins them whenever
  // the feeds or the settings change; the night's own player leaves pins be.
  const [savedUrls, setSavedUrls] = useState<ReadonlySet<string>>(new Set());
  const keeper = useLazyRef(() => new OfflineAudio(() => setSavedUrls(keeper.current.savedUrls())));
  const [keepRead, rereadKeep] = useReducer((n: number) => n + 1, 0);
  // What this site holds on the device (saved audio is most of it), when
  // Settings is open; the estimate is the browser's, so a round figure.
  const [storageUsed, setStorageUsed] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "settings") return;
    let gone = false;
    navigator.storage?.estimate?.().then((e) => {
      if (gone || !e.usage) return;
      const mb = e.usage / (1024 * 1024);
      setStorageUsed(mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
    }).catch(() => {});
    return () => { gone = true; };
  }, [tab, savedUrls]);
  const keepLatest = useMemo(() => loadKeepLatest(), [keepRead]);
  const autoKept = useMemo(() => {
    const urls = new Set<string>();
    for (const [feedId, n] of Object.entries(keepLatest)) for (const ep of latestToKeep(feedStatuses[feedId]?.episodes ?? [], n)) urls.add(ep.url);
    return urls;
  }, [keepLatest, feedStatuses]);
  useEffect(() => {
    const byFeed = Object.fromEntries(Object.entries(feedStatuses).map(([id, st]) => [id, st.episodes]));
    keeper.current.pin(pinnedUrls(keepLatest, byFeed, loadManualSaves()));
    setSavedUrls(keeper.current.savedUrls());
  }, [keepLatest, feedStatuses, keepRead]);
  const [learned, timedSoFar] = useMemo(() => {
    const nights = loadNights();
    return [learnedTimer(nights), timedNights(nights)] as const;
  }, [tab]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const yourTimer = useMemo(() => keptTimer(), [tab, keptRead]);
  const learnOn = appState.settings.learnTimer !== false;
  const auto = yourTimer?.minutes ?? (learnOn ? learned?.minutes ?? null : null);
  const usingLearned = auto !== null && appState.settings.mode.kind === "minutes" && !handPickHolds(appState.settings.timerPickedAt, Date.now());
  const timerMinutes = usingLearned && auto !== null ? auto : appState.settings.timerMinutes;
  // A running experiment gives the next ordinary night (the moon) one of its
  // two sides (lib/rest/experiment.ts). Read again on coming to this tab (an
  // experiment is started from Rest) and after each start.
  const experimentNight = useRef<PlayMode | null>(null);
  const experimentTonight = useMemo(() => {
    const e = currentExperiment();
    if (!e || experimentResult(e, loadNights()).done) return null;
    return e.arms[e.next];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goldenPending, tab]);

  /** An on/off setting, saved. */
  function setFlag(key: "favorWhatWorks", on: boolean) {
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
              author: parsed.author,
              about: parsed.about,
              notes: parsed.notes,
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
                author: parsed.author,
                about: parsed.about,
                notes: parsed.notes,
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
    setFeedError("Couldn't reach your feeds. Check your connection and try again.");
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

  function addFromCatalog(show: CatalogShow) {
    updateAndSave(addCustomFeed(appState, show.url, show.title));
  }

  function addFound(show: FoundShow) {
    updateAndSave(addCustomFeed(appState, show.feedUrl, show.title));
  }

  function handleRemoveFeed(id: string) {
    const next = removeCustomFeed(appState, id);
    updateAndSave(next);
  }

  const mode = appState.settings.mode;

  // Back to your timer, or the learned one: the hand pick, if any, let go.
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
    downloadFile(new Blob([xml], { type: "text/x-opml" }), "sleepcast-feeds.opml");
  }

  function handleBackup() {
    setBackupError(null);
    setPendingRestore(null);
    const { feeds, nights } = downloadBackup();
    setBackedUpAt(lastBackedUpAt());
    // A deliberate act of keeping: the moment to ask, where the browser asks.
    void keepStorage().then(setKept);
    setBackupNote(`Saved ${feeds} ${feeds === 1 ? "feed" : "feeds"} and ${nights} ${nights === 1 ? "night" : "nights"}. Keep the file somewhere other than this browser.`);
  }

  function handleRestoreFile(file: File) {
    setBackupNote(null);
    setBackupError(null);
    file.text().then((text) => {
      const parsed = parseBackup(text);
      if (!parsed.ok) {
        setPendingRestore(null);
        setBackupError(parsed.error);
        return;
      }
      setPendingRestore({ backup: parsed.backup, summary: parsed.summary });
      requestAnimationFrame(() => replaceBtnRef.current?.focus());
    }, () => setBackupError("That file couldn't be read. Try picking it again."));
  }

  function confirmRestore() {
    if (!pendingRestore) return;
    try {
      restoreBackup(pendingRestore.backup);
    } catch {
      setPendingRestore(null);
      setBackupError("This browser ran out of storage space, so nothing was changed. Free some space and try again.");
      return;
    }
    // Every part of the player reads storage on load: start it again on the
    // restored data rather than patching each piece of state in place.
    window.location.reload();
  }

  // For Sleepcast on the Home Screen: the Shortcut's link opens Safari, whose
  // storage is separate, so the Shortcut also copies its data to paste here.
  async function handleWatchPaste() {
    setWatchNote(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setWatchNote({ text: "Couldn't read the clipboard. Tap Paste when your phone asks, or open the Shortcut's link instead.", error: true });
      return;
    }
    const r = importWatchSleep(text);
    setWatchNote({ text: describeImport(r), error: !r.ok });
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
    const rearm = rearmNightRef.current ?? experimentNight.current;
    rearmNightRef.current = null;
    experimentNight.current = null;
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
      setFeedError("Couldn't reach your feeds. Check your connection and try again.");
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
    let picked = scoped.length ? scoped : pool;
    // An experiment night, only for an ordinary start: one that picked a
    // show, an episode or a re-arm chose for itself. A show that isn't on
    // (or hasn't loaded) can't be played, so that night isn't counted.
    const e = scope || leadRef.current || rearmNightRef.current ? null : currentExperiment();
    if (e && !experimentResult(e, loadNights()).done) {
      const arm = e.arms[e.next];
      const fromShow = arm.kind === "show" ? pool.filter((ep) => ep.feedId === arm.feedId) : [];
      if (arm.kind === "timer" || fromShow.length) {
        assignTonight();
        if (arm.kind === "show") picked = fromShow;
        else experimentNight.current = { kind: "minutes", minutes: arm.minutes };
      }
    }
    startWith(picked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goldenPending, canStart]);

  // A natural end (the timer ran out) inside the last six hours means someone may have woken
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

  const poolNote = pool.length > 0 ? `${pool.length} episodes ready` : "Gathering episodes…";

  return (
    // The page owns the background (globals.css tokens); this lays out inside it.
    <div className="text-[var(--ink-2)]" hidden={tab === null}>
      {/* A phone's width, and a wide screen's room on one. */}
      <div className="mx-auto max-w-lg lg:max-w-none">
        {tab === "sleep" && (() => {
          const hour = new Date().getHours();
          const greeting = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 18 ? "Good afternoon" : hour >= 18 && hour < 22 ? "Good evening" : "Good night";
          const poolShows = new Set(pool.map((e) => e.feedId)).size;
          const timerLine = mode.kind === "one-episode"
            ? "One episode · stops when it ends"
            : mode.kind === "all-night"
              ? "All night · until you stop it"
              : `${timerMinutes} min · then it stops`;
          const artOf = (feedId: string) => feedStatuses[feedId]?.artwork;
          const lastFeed = lastEpisode ? appState.feeds.find((f) => f.id === lastEpisode.feedId) : undefined;
          const showRearm = Boolean(rearmable && !goldenPending);
          const showSuggestion = Boolean(suggestion && !experimentTonight);
          const hasCards = Boolean(lastEpisode || feedError || showRearm || showSuggestion || experimentTonight);
          const cardClass = "rounded-2xl bg-[var(--surface)] p-4 ring-1 ring-[var(--line)]";
          const eyebrow = "text-[11px] font-bold uppercase tracking-wider text-[var(--accent-text)]";

          const cards = (
            <div className="space-y-3">

              {lastEpisode && (
                <div className={cardClass}>
                  <button onClick={handleExactAgain} disabled={goldenPending} className="group flex w-full items-center gap-3.5 text-left disabled:opacity-50">
                    {lastFeed ? (
                      <span className="w-16 shrink-0"><ShowArt feed={lastFeed} artwork={artOf(lastFeed.id)} label={false} className="rounded-lg" /></span>
                    ) : null}
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className={`block ${eyebrow}`}>{lastEpisodePosition > 0 ? "Pick up where you drifted" : "The exact one again"}</span>
                      <span className="line-clamp-2 block font-semibold leading-snug text-[var(--ink)]">{lastEpisode.title}</span>
                      <span className="block text-xs text-[var(--ink-3)]">
                        {lastEpisodePosition > 0 ? `from ${formatTime(lastEpisodePosition)}` : lastFeed?.title ?? "from the start"}
                      </span>
                    </span>
                    <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)] transition-transform group-hover:scale-105">
                      <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-5 w-5"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
                    </span>
                  </button>
                  {lastEpisodePosition > 0 && (
                    <button
                      onClick={handleExactAgainFromStart}
                      disabled={goldenPending}
                      className="mt-3 text-xs font-semibold text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)] disabled:opacity-50"
                    >
                      Play it from the start
                    </button>
                  )}
                </div>
              )}

              {feedError && <p role="alert" className="text-xs text-[var(--danger)]">{feedError}</p>}

              {showRearm && rearmable && (
                <div className={`${cardClass} flex items-center justify-between gap-3`}>
                  <span>
                    <span className={`block ${eyebrow}`}>Still awake?</span>
                    <span className="block text-sm text-[var(--ink-2)]">{rearmable.modeKind === "one-episode" ? "One more episode, then it stops." : `Half the last timer: ${rearmM} min.`}</span>
                  </span>
                  <button onClick={handleRearm} className="shrink-0 rounded-full bg-[var(--raised)] px-4 py-2 text-sm font-bold text-[var(--ink)] hover:bg-[var(--line)]">
                    {rearmable.modeKind === "one-episode" ? "One more" : `Resume · ${rearmM} min`}
                  </button>
                </div>
              )}

              {/* Names one feed and the reason, so the pick is never asserted
                  without the evidence beside it — and never without a one-tap
                  refusal, since a suggestion that can't be waved off is a nag.
                  Not during an experiment: a suggested show would tilt it. */}
              {showSuggestion && suggestion && (
                <div className={cardClass}>
                  <div className="flex items-center gap-3.5">
                    <span className="w-14 shrink-0"><ShowArt feed={suggestion.feed} artwork={artOf(suggestion.feed.id)} label={false} className="rounded-lg" /></span>
                    <span className="min-w-0">
                      <span className={`block ${eyebrow}`}>Tonight</span>
                      <span className="block font-semibold leading-snug text-[var(--ink)]">{suggestion.feed.title} leads tonight.</span>
                      <span className="block text-xs text-[var(--ink-3)]">{suggestion.line}</span>
                    </span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => beginNight(leadFromFeed(suggestion.feed.id))}
                      disabled={goldenPending || !suggestionReady}
                      title={suggestionReady ? undefined : "Still loading that feed's episodes…"}
                      className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent-ink)] disabled:opacity-50"
                    >
                      Start
                    </button>
                    <button
                      onClick={() => beginNight(null)}
                      disabled={goldenPending}
                      className="rounded-full bg-[var(--raised)] px-4 py-1.5 text-sm font-semibold text-[var(--ink-2)] hover:text-[var(--ink)] disabled:opacity-50"
                    >
                      Something else
                    </button>
                  </div>
                </div>
              )}

              {experimentTonight && (
                <div className={`${cardClass} flex gap-3`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text)]" aria-hidden="true"><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7 15h10" /></svg>
                  <p className="text-sm text-[var(--ink-2)]">
                    {experimentTonight.kind === "show"
                      ? `Experiment night: only ${appState.feeds.find((f) => f.id === experimentTonight.feedId)?.title ?? "a show you removed"} tonight, from the moon.`
                      : `Experiment night: a ${experimentTonight.minutes}-minute timer tonight, from the moon.`}
                    {experimentTonight.kind === "show" && !enabledFeeds.some((f) => f.id === experimentTonight.feedId)
                      ? " Turn it on in Podcasts for tonight to count."
                      : ""}
                  </p>
                </div>
              )}

              {(lastEpisode || showSuggestion) && (
                <p className="px-1 text-xs text-[var(--ink-4)]">Or tap the moon: the same shows, on shuffle.</p>
              )}
            </div>
          );

          return (
        <div className="space-y-6 pb-4">
          <header className="space-y-1">
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">{greeting}</h1>
            <p className="text-sm text-[var(--ink-3)]">
              {pool.length > 0 ? `${poolNote} from ${poolShows} ${poolShows === 1 ? "show" : "shows"}` : poolNote}
            </p>
          </header>

          {/* A yes or no, so it may sit above the moon. */}
          {greetNight && (
            <div className={`${cardClass} flex items-center justify-between gap-3`}>
              <p className="font-semibold text-[var(--ink)]">Did you sleep well?</p>
              <span className="flex gap-2">
                <button onClick={() => handleSleepLabel("slept")} className="rounded-full bg-[var(--raised)] px-4 py-1.5 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--accent)] hover:text-[var(--accent-ink)]">Yes</button>
                <button onClick={() => handleSleepLabel("awake")} className="rounded-full bg-[var(--raised)] px-4 py-1.5 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--line)]">No</button>
              </span>
            </div>
          )}

          <div className={hasCards || enabledFeeds.length > 0 ? "space-y-6 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-8 lg:space-y-0" : "space-y-6"}>
            {/* The moon IS the button: the same moon the Player veils the
                countdown behind, so the object you tap to fall asleep is the
                object holding the time you're not allowed to see. */}
            <section className="sleep-sky flex flex-col items-center gap-1 overflow-hidden rounded-3xl px-4 pb-6 pt-8 ring-1 ring-[var(--line)] lg:px-8 lg:pt-12">
              <button
                onClick={handleGolden}
                disabled={goldenPending}
                aria-label="sleep"
                className="group relative grid h-48 w-48 place-items-center rounded-full disabled:cursor-wait lg:h-56 lg:w-56"
              >
                <span
                  aria-hidden="true"
                  className="setup-moon-glow pointer-events-none absolute -inset-8 rounded-full [background:radial-gradient(circle,rgba(240,220,184,0.16)_0%,rgba(240,220,184,0)_68%)]"
                />
                <span
                  aria-hidden="true"
                  className="setup-moon select-none text-[7.5rem] leading-none text-[var(--accent)] [text-shadow:0_0_60px_rgba(240,220,184,0.35)] transition-transform group-active:scale-95 lg:text-[8.5rem]"
                >
                  ☾
                </span>
              </button>
              <p role="status" className="font-serif-display -mt-3 text-3xl text-[var(--ink)]">
                {goldenPending ? "Tucking you in…" : "Sleep"}
              </p>
              <p className="text-sm text-[var(--ink-3)]">{timerLine}</p>

              {/* The only other decision on this screen: how long. Minutes, or
                  one episode (stops when it ends), or all night (stopped by hand).
                  Inside the moon's panel: the timer is the moon's. */}
              <div role="group" aria-labelledby="timer-title" className="mt-6 w-full space-y-3 border-t border-[var(--line)] pt-5">
                <h2 id="timer-title" className="text-center text-sm font-bold text-[var(--ink-2)]">Sleep timer</h2>
                <div className="flex flex-wrap justify-center gap-2">
                  {yourTimer && (
                    <Pill on={usingLearned} onClick={selectLearned} label={`Your timer: ${yourTimer.minutes} minutes`}>
                      Your timer · {yourTimer.minutes} min
                    </Pill>
                  )}
                  {learnOn && learned && (
                    // With your timer kept, going back to the learned one lets it go.
                    <Pill on={usingLearned && !yourTimer} onClick={() => { if (yourTimer) { dropKeptTimer(); rereadKept(); } selectLearned(); }} label={`Learned: ${learned.minutes} minutes`}>
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
                {(learnOn || yourTimer) && (
                  <p className="mx-auto max-w-md text-center text-xs leading-snug text-[var(--ink-3)]">
                    {yourTimer
                      ? usingLearned
                        ? `Your timer: ${yourTimer.minutes} min put you to sleep faster than ${yourTimer.beat} min in your experiment.${learnOn && learned ? " Tap Learned to go back to learning it from your nights." : ""}`
                        : mode.kind === "minutes"
                          ? `Your pick for tonight. Tomorrow it's back to ${yourTimer.minutes} min, your timer.`
                          : `Your timer: ${yourTimer.minutes} min, when you want one.`
                      : !learned
                      ? `After ${LEARN_MIN_NIGHTS} timed nights the timer learns how long you take to fall asleep (${Math.min(timedSoFar, LEARN_MIN_NIGHTS)} so far).`
                      : usingLearned
                        ? `You're usually under in about ${fmtOnsetMinutes(learned.usualMs)}, so ${learned.minutes} min leaves room. From your last ${learned.nights} nights.`
                        : mode.kind === "minutes"
                          ? `Your pick for tonight. Tomorrow it's back to ${learned.minutes} min, learned.`
                          : `Learned from your nights: ${learned.minutes} min, when you want a timer.`}
                  </p>
                )}
                {yourTimer && (
                  <button
                    onClick={() => { dropKeptTimer(); rereadKept(); selectLearned(); }}
                    className="mx-auto block text-xs text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]"
                  >
                    Forget your timer
                  </button>
                )}
              </div>
            </section>

            <div className="space-y-6">
              {hasCards && cards}

              {/* What the moon will shuffle tonight: the shows that are on. */}
              {enabledFeeds.length > 0 && (
                <section aria-labelledby="shuffle-title" className="space-y-3">
                  <h2 id="shuffle-title" className="text-xl font-bold tracking-tight text-[var(--ink)]">In tonight&apos;s shuffle</h2>
                  <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0 lg:grid lg:grid-cols-3 lg:overflow-visible">
                    {enabledFeeds.map((f) => (
                      <li key={f.id} className="w-28 shrink-0 lg:w-auto">
                        <ShowArt feed={f} artwork={artOf(f.id)} label={false} className="rounded-xl" />
                        <span className="mt-1.5 line-clamp-2 block text-[13px] font-semibold leading-snug text-[var(--ink)]">{f.title}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        </div>
          );
        })()}
        {tab === "podcasts" && openShow && (() => {
          const feed = appState.feeds.find((f) => f.id === openShow);
          if (!feed) return null;
          const positions = loadPositions();
          const blockedNow = new Set(loadBlocked());
          const heard = new Set(getPlays().filter((p) => p.heardSec >= HEARD_SEC).map((p) => p.id));
          const listed = CATALOG.find((c) => c.url === feed.url);
          const similar = listed
            ? CATALOG.filter((c) => c.style === listed.style && c.url !== feed.url).map((show) => ({
                show,
                feedId: appState.feeds.find((f) => f.url === show.url)?.id,
                added: isAdded(show, appState.feeds),
              }))
            : [];
          return (
            <ShowPage
              key={feed.id}
              feed={feed}
              styleLabel={listed && CATALOG_STYLES.find((c) => c.style === listed.style)?.label}
              similar={similar}
              onAddSimilar={addFromCatalog}
              onOpenShow={openShowPage}
              status={feedStatuses[feed.id] && { ...feedStatuses[feed.id], episodes: feedStatuses[feed.id].episodes.filter((e) => !blockedNow.has(e.id)) }}
              heard={heard}
              positions={positions}
              onBack={() => { returnToShowRef.current = feed.id; setOpenShow(null); }}
              onPlay={(ep, fromStart) => beginNight(ep, fromStart ? 0 : positions[ep.id] ?? 0)}
              onChanged={redrawShows}
              nightLive={nightLive}
              keepLatest={keepLatest[feed.id] ?? 0}
              onKeepLatest={(n) => { saveKeepLatest(feed.id, n); rereadKeep(); }}
              saved={savedUrls}
              autoKept={autoKept}
              onToggleSaved={(ep) => { toggleManualSave(ep.url); rereadKeep(); }}
              onShuffle={() => { scopeRef.current = feed.id; beginNight(null); }}
              onToggleShuffle={() => toggleFeed(feed.id)}
              onRemove={feed.builtin ? undefined : () => { handleRemoveFeed(feed.id); setOpenShow(null); }}
            />
          );
        })()}
        {tab === "podcasts" && !openShow && (() => {
          const positions = loadPositions();
          const blockedNow = new Set(loadBlocked());
          const plays = getPlays();
          const byFeed = new Map(appState.feeds.map((f) => [f.id, f]));
          const resumable = jumpBackIn(
            appState.feeds.flatMap((f) => (feedStatuses[f.id]?.episodes ?? []).filter((e) => !blockedNow.has(e.id))),
            positions,
            plays,
          );
          return (
          <div className="space-y-10 pb-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">Podcasts</h1>
          <button
            onClick={() => {
              findRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              findRef.current?.focus({ preventScroll: true });
            }}
            aria-label="Find a podcast"
            title="Find a podcast"
            className="grid h-10 w-10 place-items-center rounded-full text-[var(--ink)] hover:bg-[var(--raised)]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-6 w-6" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>

        <JumpBackIn
          items={resumable.flatMap((ep) => {
            const feed = byFeed.get(ep.feedId);
            return feed ? [{ ep, feed, artwork: feedStatuses[feed.id]?.artwork }] : [];
          })}
          positions={positions}
          onPlay={(ep) => beginNight(ep, positions[ep.id] ?? 0)}
        />

        <section aria-labelledby="your-shows-title" className="space-y-3">
          <h2 id="your-shows-title" className="text-xl font-bold tracking-tight text-[var(--ink)]">Your shows</h2>
          <Library
            feeds={appState.feeds}
            statuses={feedStatuses}
            lastPlayed={lastPlayedByFeed(plays)}
            onOpen={openShowPage}
            onAdd={() => {
              findRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
              findRef.current?.focus({ preventScroll: true });
            }}
          />
        </section>

        <FindShow feeds={appState.feeds} onAdd={addFound} onOpen={openShowPage} inputRef={findRef} />

        <ShowCatalog feeds={appState.feeds} onAdd={addFromCatalog} onOpen={openShowPage} headingRef={catalogRef} />

        {/* Add by link: a private feed, or anything not in the catalog. */}
        <section ref={addShowRef} aria-labelledby="add-by-link-title" className="scroll-mt-20 space-y-2 rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-4 lg:max-w-xl">
            <h2 id="add-by-link-title" className="text-lg font-bold tracking-tight text-[var(--ink)]">
              Add by link
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
              placeholder="As it should appear"
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
                Import OPML
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
                Export OPML
              </button>
            </div>
            <p role="status" className="text-xs text-[var(--ink-4)] empty:hidden">{opmlNote ?? ""}</p>
        </section>
          </div>
          );
        })()}
        {tab === "settings" && (
          <div className="space-y-6 pb-8">
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">Settings</h1>

            {/* Where a phone's settings show your account: there is none, so
                what this device holds, and whether it's backed up. */}
            <div className="flex items-center gap-4 rounded-2xl bg-[var(--surface)] p-4 ring-1 ring-[var(--line)]">
              <span aria-hidden="true" className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-3xl leading-none text-[var(--accent-ink)]">☾</span>
              <div className="min-w-0 flex-1">
                <p className="text-lg font-bold tracking-tight text-[var(--ink)]">This device</p>
                <p className="text-[13px] text-[var(--ink-3)]">
                  {`${appState.feeds.length} ${appState.feeds.length === 1 ? "show" : "shows"}, ${pluralNights(summarizeStored().nights)} · ${backedUpAt ? `backed up ${fmtBackupDate(backedUpAt)}` : "not backed up yet"}`}
                </p>
              </div>
              <button onClick={handleBackup} className="hidden shrink-0 rounded-full bg-[var(--raised)] px-4 py-2 text-sm font-bold text-[var(--ink)] hover:bg-[var(--line)] sm:block">
                Back up
              </button>
            </div>

            {/* Two columns on a wide screen: what the app does, then the
                watch and the backup. */}
            <div className="space-y-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-8 lg:space-y-0">
            <div className="space-y-6">
            <Group id="shuffle" title="Shuffle">
              {/* The shuffle leaning on the sleep scores, off unless asked
                  for: a pool that narrows on its own is hard to notice going
                  wrong, so the listener chooses it knowingly, and off is the
                  plain shuffle to compare against (the scoring spec, §8). */}
              <SettingRow
                id="favor"
                icon={ICONS.favor}
                title="Favour what puts me under"
                checked={appState.settings.favorWhatWorks}
                onChange={(on) => setFlag("favorWhatWorks", on)}
              >
                Plays the shows you fall asleep to a bit more often. Nothing is ruled out.
              </SettingRow>
            </Group>

            <Group id="timer" title="Sleep timer">
              <SettingRow
                id="learn-timer"
                icon={ICONS.learn}
                title="Learn my timer"
                checked={learnOn}
                onChange={(on) => updateAndSave({ ...appState, settings: { ...appState.settings, learnTimer: on } })}
              >
                Sets the timer from how long you usually take to fall asleep.
              </SettingRow>
              {/* A custom timer is the long tail of the timer presets. */}
              <div className="flex items-center gap-3 py-3.5">
                <RowIcon d={ICONS.custom} />
                <label htmlFor="custom-minutes" className="flex-1 space-y-0.5">
                  <span className="block font-semibold text-[var(--ink)]">Custom timer</span>
                  <span className="block text-[12.5px] text-[var(--ink-3)]">
                    {mode.kind === "minutes" ? `Now ${timerMinutes} min.` : "Any length, in minutes."}
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
                  className="w-20 rounded-full border border-[var(--line)] bg-[var(--raised)] px-2 py-2 text-center text-base text-[var(--ink)] placeholder:text-[var(--ink-4)] focus:border-[var(--accent)] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  aria-label="Custom timer minutes"
                />
              </div>
            </Group>

            <Group id="playback" title="Playback">
              <SettingRow
                id="save-ahead"
                icon={ICONS.saveAhead}
                title="Keep playing without internet"
                checked={appState.settings.saveAhead !== false}
                onChange={(on) => updateAndSave({ ...appState, settings: { ...appState.settings, saveAhead: on } })}
              >
                Downloads the current and next episode, so a dropped connection doesn&apos;t stop playback. Uses more data off Wi-Fi.
              </SettingRow>
              <p className="py-3 text-[12.5px] text-[var(--ink-3)]">
                {storageUsed === null
                  ? "To keep a show's latest episodes on the device, open it in Podcasts."
                  : `Sleepcast is using ${storageUsed} on this device. To keep a show's latest episodes, open it in Podcasts.`}
              </p>
            </Group>

            <Group id="about" title="About">
              <div className="flex items-center gap-3 py-3.5">
                <RowIcon d={ICONS.appearance} />
                <span className="flex-1 space-y-0.5">
                  <span className="block font-semibold text-[var(--ink)]">Appearance</span>
                  <span className="block text-[12.5px] text-[var(--ink-3)]">Follows your phone.</span>
                </span>
              </div>
              <a href="/privacy" className="group flex items-center gap-3 py-3.5">
                <RowIcon d={ICONS.privacy} />
                <span className="flex-1 space-y-0.5">
                  <span className="block font-semibold text-[var(--ink)] group-hover:underline group-hover:decoration-[var(--line)] group-hover:underline-offset-4">Privacy and analytics</span>
                  <span className="block text-[12.5px] text-[var(--ink-3)]">How Sleepcast handles your data.</span>
                </span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 shrink-0 text-[var(--ink-4)]" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </a>
            </Group>
            </div>

            <div className="space-y-6">
            <Group id="watch" title="Sleep from your watch" padded>
              <p className="text-[13px] leading-snug text-[var(--ink-3)]">
                A Shortcut can bring your Apple Watch sleep here each morning, in place of Sleepcast&apos;s own guess. It never leaves your phone.
              </p>
              <details className="group rounded-xl bg-[var(--raised)] px-3.5 py-3 text-[12.5px] leading-snug text-[var(--ink-2)]">
                <summary className="flex cursor-pointer list-none items-center justify-between rounded font-semibold text-[var(--ink)] [&::-webkit-details-marker]:hidden">
                  Set up the Shortcut
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 text-[var(--ink-3)] transition-transform group-open:rotate-90" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                </summary>
                <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                  <li>In Shortcuts, make a new shortcut and add <b>Find Health Samples</b>. Set Type to Sleep Analysis, and add two filters: Start Date is in the last 1 day, and Value is not In Bed. Sort by Start Date, Latest First, and turn on Limit at 200.</li>
                  <li>If another sleep app also writes to Health, add the filter Source is your Apple Watch, so each night comes through once.</li>
                  <li>Add <b>Repeat with Each</b> on the Health Samples.</li>
                  <li>Inside it, add <b>Text</b>: Repeat Item&apos;s Start Date, then <code>|</code>, then its End Date, then <code>|</code>, then its Value. Set both dates&apos; format to ISO 8601 with the time included.</li>
                  <li>After the repeat, add <b>Combine Text</b> on Repeat Results, separated by Custom <code>;</code>.</li>
                  <li>Add <b>Copy to Clipboard</b> with the combined text.</li>
                  <li>Add <b>URL Encode</b> on the combined text, then <b>Open URLs</b> with <code className="break-all">{typeof window !== "undefined" ? window.location.origin : "https://sleepcast.pro"}/#watch=</code> followed by the encoded text.</li>
                  <li>To run it every morning, add an Automation in Shortcuts, such as when your wake-up alarm is stopped.</li>
                </ol>
                <p className="mt-2 text-[var(--ink-3)]">Using the Home Screen app? After the Shortcut runs, open Sleepcast and tap Add from clipboard.</p>
              </details>
              <button
                onClick={() => { void handleWatchPaste(); }}
                className="w-full rounded-full bg-[var(--raised)] py-2.5 text-sm font-bold text-[var(--ink)] hover:bg-[var(--line)]"
              >
                Add from clipboard
              </button>
              <p role="alert" className="text-xs text-[var(--danger)] empty:hidden">{watchNote?.error ? watchNote.text : ""}</p>
              <p role="status" className="text-xs text-[var(--ink-3)] empty:hidden">{watchNote && !watchNote.error ? watchNote.text : ""}</p>
            </Group>

            {/* Everything here lives only in this browser's storage. */}
            <Group id="history" title="Your history" padded>
              <p className="text-[13px] leading-snug text-[var(--ink-3)]">
                Everything is stored only in this browser. Back up now and then so you don&apos;t lose it.
              </p>
              <p className="text-[13px] font-semibold leading-snug text-[var(--ink-2)]">
                {backedUpAt ? `Last backed up ${fmtBackupDate(backedUpAt)}.` : "Not backed up yet."}
                {kept ? <span className="font-normal text-[var(--ink-3)]"> This browser won&apos;t clear it on its own.</span> : ""}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleBackup}
                  className="flex-1 rounded-full bg-[var(--accent)] py-2.5 text-sm font-bold text-[var(--accent-ink)]"
                >
                  Back up
                </button>
                <label className="flex-1 cursor-pointer rounded-full bg-[var(--raised)] py-2.5 text-center text-sm font-bold text-[var(--ink)] hover:bg-[var(--line)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-text)]">
                  Restore…
                  <input
                    id="restore-file"
                    type="file"
                    accept=".json,application/json"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleRestoreFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
              </div>
              {pendingRestore && (
                <div role="group" aria-labelledby="restore-question" className="space-y-2 rounded-xl bg-[var(--raised)] p-3">
                  <p id="restore-question" className="text-[12.5px] leading-snug text-[var(--ink-2)]">
                    Replace what&apos;s here ({describeSummary(summarizeStored())}) with the backup
                    {pendingRestore.backup.exportedAt ? ` from ${fmtBackupDate(Date.parse(pendingRestore.backup.exportedAt))}` : ""} ({describeSummary(pendingRestore.summary)})? The page reloads afterwards.
                  </p>
                  <div className="flex gap-2">
                    <button
                      ref={replaceBtnRef}
                      onClick={confirmRestore}
                      className="flex-1 rounded-full bg-[var(--accent)] py-2 text-sm font-bold text-[var(--accent-ink)]"
                    >
                      Replace
                    </button>
                    <button
                      onClick={() => setPendingRestore(null)}
                      className="flex-1 rounded-full bg-[var(--surface)] py-2 text-sm font-bold text-[var(--ink-2)] hover:text-[var(--ink)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <p role="alert" className="text-xs text-[var(--danger)] empty:hidden">{backupError ?? ""}</p>
              <p role="status" className="text-xs text-[var(--ink-4)] empty:hidden">{backupNote ?? ""}</p>
            </Group>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
