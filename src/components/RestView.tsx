import { useMemo, useReducer, useRef, useState } from "react";
import { loadNights, rollup, setSelfLabel, leanComparison } from "../lib/rest/ledger";
import { recordFalsePositive, guessAccuracy } from "../lib/rest/calibrate";
import { scoreFeeds, medianTimeToSleep, meetsSuggestionGate, shuffleWeights, pluralNights, fmtOnsetMinutes, MIN_NIGHTS, WEIGHT_MAX } from "../lib/rest/sleepscore";
import { fmtDuration, lastNight } from "../lib/rest/surface";
import { describeImport, describeWatchNight, importWatchSleep } from "../lib/rest/watch";
import { NightChart } from "./NightChart";
import { NightsTrend } from "./NightsTrend";
import { WakeAudit } from "./WakeAudit";
import { Experiments } from "./Experiments";
import { RateMorning, RestedLinks } from "./MorningRating";
import { nightToRate } from "../lib/rest/rested";
import { provenShows } from "../lib/rest/experiment";
import { getPlays, loadState } from "../lib/store";
import { backupReminder, keepStorage, snoozeBackupReminder } from "../lib/keep";
import { downloadBackup } from "../lib/backup";
import { playsSince, playAtMoment } from "../lib/plays";
import { localCover } from "../lib/covers";
import { ShowArt } from "./Shows";
import type { FeedRef } from "../lib/store";

/** The Rest tab's chips: everything, or one part of it. */
type RestFilter = "all" | "nights" | "shows" | "insights";
const FILTERS: { key: RestFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "nights", label: "Nights" },
  { key: "shows", label: "Shows" },
  { key: "insights", label: "Insights" },
];

/** `onClose` when shown as its own screen; in the Rest tab there is none,
 *  and a label just redraws the view. */
export function RestView({ onClose, note = null }: { onClose?: () => void; note?: string | null }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // Read again after the watch's sleep is added from here.
  const [imports, reloadNights] = useReducer((n: number) => n + 1, 0);
  const nights = useMemo(() => loadNights(), [imports]);
  const r = useMemo(() => rollup(nights), [nights]);
  const watched = useMemo(() => nights.filter((n) => n.watchSleep?.length), [nights]);
  const accuracy = useMemo(() => guessAccuracy(nights), [nights]);
  const last = lastNight();
  // Asked the morning after only (rested.ts): read once, so a rating made
  // here doesn't move the question while you're looking at it.
  const [toRate] = useState(() => nightToRate(nights, Date.now()));
  // Shown the morning after, here, never on the bedtime screen: a reminder
  // at bedtime is the kind of nudge the app exists not to make.
  const [reminder] = useState(() => backupReminder(nights));
  const [reminderDone, setReminderDone] = useState<string | null>(null);
  const reminderDoneRef = useRef<HTMLParagraphElement>(null);

  const [watchNote, setWatchNote] = useState<{ text: string; error: boolean } | null>(null);
  // As in Settings: from the Home Screen, the Shortcut's link opens Safari,
  // whose storage is separate, so its data comes in by the clipboard.
  async function addWatchFromClipboard() {
    setWatchNote(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setWatchNote({ text: "Couldn't read the clipboard. Tap Paste when your phone asks, or open the Shortcut's link instead.", error: true });
      return;
    }
    const r = importWatchSleep(text);
    setWatchNote({ text: describeImport(r, { brief: true }), error: !r.ok });
    if (r.ok && r.matched.length) reloadNights();
  }

  // The buttons go when pressed: focus moves to what took their place.
  function closeReminder(text: string) {
    setReminderDone(text);
    requestAnimationFrame(() => reminderDoneRef.current?.focus());
  }

  // Only custom feeds can go missing from here — loadState always re-merges
  // every BUILTIN_FEEDS entry regardless of what's saved, and removeCustomFeed
  // no-ops on builtins. So a lookup miss below is always a removed custom feed.
  // (And whether the shuffle leans: shown per feed while it's on, so the
  // lean is as auditable as the ranking; only for a feed that is on, since
  // setup builds no lineup from a removed or switched-off one. A 3am
  // re-anchor carries the faded night's lineup, so a feed switched off since
  // can still lean that one night, unlisted.)
  const { feedTitles, enabledFeeds, favorWhatWorks, learnTimer, feeds, feedRefs } = useMemo(() => {
    const s = loadState();
    return {
      feedRefs: Object.fromEntries(s.feeds.map((f) => [f.id, f])) as Record<string, FeedRef>,
      feeds: s.feeds.map((f) => ({ id: f.id, title: f.title, enabled: f.enabled })),
      feedTitles: Object.fromEntries(s.feeds.map((f) => [f.id, f.title])),
      enabledFeeds: new Set(s.feeds.filter((f) => f.enabled).map((f) => f.id)),
      favorWhatWorks: s.settings.favorWhatWorks,
      learnTimer: s.settings.learnTimer !== false,
    };
  }, []);

  // scoreFeeds, not rankedFeeds: the panel shows everything including feeds
  // below the suggestion threshold. Its whole job is to be auditable, and
  // hiding the thin evidence would defeat that. But it still has to agree
  // with the suggestion about which feeds count — meetsSuggestionGate is the
  // exact predicate rankedFeeds uses, so the two can never name a different
  // leader for "what puts you under."
  const scored = useMemo(() => scoreFeeds(nights), [nights]);
  const counted = useMemo(() => scored.filter(meetsSuggestionGate), [scored]);
  const notYetCounted = useMemo(() => scored.filter((f) => !meetsSuggestionGate(f)), [scored]);
  // Experiment results lean it too, ahead of the record (shuffleWeights).
  const proven = useMemo(() => provenShows(nights), [nights]);
  const leanOf = useMemo(() => (favorWhatWorks ? shuffleWeights(scored, proven) : null), [scored, proven, favorWhatWorks]);
  // Leaned nights against plain ones, once there are leaned nights and
  // either side has a timed one (leanComparison): the baseline the setting
  // keeps is only worth keeping if it is compared.
  const compared = useMemo(() => leanComparison(nights), [nights]);

  // What actually played last night, from the play ledger. Entries only exist
  // once an episode ran past HEARD_SEC, so a track skipped in the first breath
  // never shows up here.
  const lastPlays = useMemo(
    () => (last ? playsSince(getPlays(), last.startedAt) : []),
    [last?.startedAt],
  );
  // The episode running at the moment the detector decided you'd gone.
  const driftedDuring = useMemo(
    () =>
      last && last.sleptAtMs !== null
        ? playAtMoment(lastPlays, last.startedAt + last.sleptAtMs)
        : null,
    [lastPlays, last?.startedAt, last?.sleptAtMs],
  );

  // Shared row markup so the two groups below (counted / not-yet-counted)
  // can never drift apart in what they show per feed. Counted shows carry
  // their rank, as a chart would.
  function feedRow(f: (typeof scored)[number], rank: number | null) {
    const median = medianTimeToSleep(nights, f.feedId);
    const lean = enabledFeeds.has(f.feedId) ? leanOf?.(f.feedId) : undefined;
    const ref = feedRefs[f.feedId];
    return (
      <li key={f.feedId} className="grid grid-cols-[1.25rem_44px_minmax(0,1fr)] items-center gap-3">
        <span className="text-center text-base font-extrabold tabular-nums text-[var(--ink-3)]">{rank ?? "·"}</span>
        <span className="w-11">
          {ref
            ? <ShowArt feed={ref} artwork={localCover(ref)} label={false} className="rounded-md" />
            : <span aria-hidden="true" className="block aspect-square w-full rounded-md bg-[var(--raised)]" />}
        </span>
        <span className="min-w-0">
          {/* Raw ids for builtins ("swm") are readable enough to ship;
              a removed custom feed's id ("custom-1699999999-ab3f2")
              is not, so a title-less feed gets a plain label instead
              of leaking that internal id into the UI. */}
          <span className="block truncate text-[15px] font-semibold text-[var(--ink)]">{feedTitles[f.feedId] ?? "a show you removed"}</span>
          <span className="block truncate text-xs text-[var(--ink-3)]">
            {/* Worded as the evidence sentence words it, so the two can be checked against each other. */}
            {[median !== null ? `${fmtOnsetMinutes(median)} to sleep` : null, pluralNights(f.nights), f.skipNights > 0 ? `${f.skipNights} skipped` : null].filter(Boolean).join(" · ")}
          </span>
          {/* Relative: the shuffle weighs a night's lineup against itself. */}
          {lean !== undefined && (lean !== 1 || proven.has(f.feedId)) && (
            <span className="mt-1 inline-block rounded-full bg-[var(--raised)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ink-2)]">
              {[`weighs ×${lean.toFixed(2)}`, proven.has(f.feedId) ? `${proven.get(f.feedId)} an experiment` : ""].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      </li>
    );
  }

  // Time to sleep, night by night, for the headline's little chart.
  const recent = nights.filter((n) => n.timeToSleepMs !== null).slice(-14);
  const recentMax = Math.max(1, ...recent.map((n) => n.timeToSleepMs!));
  const [filter, setFilter] = useState<RestFilter>("all");
  const show = (k: Exclude<RestFilter, "all">) => filter === "all" || filter === k;

  function label(kind: "slept" | "awake") {
    if (!last) return;
    setSelfLabel(last.startedAt, kind);
    // a confirmed false positive tightens the detector for next time
    if (kind === "awake" && last.sleptAtMs !== null) {
      recordFalsePositive();
    }
    if (onClose) onClose();
    else redraw();
  }

  return (
    <div className="space-y-4 pb-8 text-[var(--ink-3)]">
      <header className="space-y-1">
        <h1 className="text-3xl font-extrabold tracking-tight text-[var(--ink)]">Rest</h1>
      </header>

      <p role="status" className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[13px] text-[var(--ink-2)] empty:hidden">{note ?? ""}</p>

      {/* Two columns on a wide screen, in the same order as one: the asks
          side by side on top, then the charts beside the figures. */}
      <div className="space-y-4 empty:hidden lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
      {toRate && <RateMorning night={toRate} onRated={reloadNights} />}

      {reminder && (
        <section aria-labelledby="backup-reminder-title" className="space-y-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 id="backup-reminder-title" className="text-lg font-bold tracking-tight text-[var(--ink)]">Back up your nights</h2>
          {reminderDone === null ? (
            <>
              <p className="text-[13px] text-[var(--ink-2)]">
                {reminder.everBackedUp
                  ? `${pluralNights(reminder.nights)} since your last backup are kept only in this browser. Save a new backup to keep them if it clears its storage.`
                  : `Your ${pluralNights(reminder.nights)}, feeds and settings are kept only in this browser. Save a backup to keep them if it clears its storage.`}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const { nights: saved } = downloadBackup();
                    void keepStorage();
                    closeReminder(`Saved ${pluralNights(saved)}. Keep the file somewhere other than this browser.`);
                  }}
                  className="flex-1 rounded-full bg-[var(--accent)] py-2.5 text-sm font-bold text-[var(--accent-ink)]"
                >
                  Back up
                </button>
                <button
                  onClick={() => {
                    snoozeBackupReminder();
                    closeReminder("Hidden for a week. You can back up anytime in Settings.");
                  }}
                  className="flex-1 rounded-full bg-[var(--raised)] py-2.5 text-sm font-bold text-[var(--ink-2)] hover:text-[var(--ink)]"
                >
                  Not now
                </button>
              </div>
            </>
          ) : (
            <p ref={reminderDoneRef} tabIndex={-1} role="status" className="text-[13px] text-[var(--ink-2)] outline-none">{reminderDone}</p>
          )}
        </section>
      )}
      </div>

      {/* The headline, first on every screen: how long you usually take,
          under the night sky, with the nights behind it. */}
      <section aria-labelledby="rest-headline" className="sleep-sky overflow-hidden rounded-3xl p-5 ring-1 ring-[var(--line)] lg:p-7">
        <div className="lg:flex lg:items-end lg:justify-between lg:gap-10">
          <div className="space-y-1">
            <h2 id="rest-headline" className="text-sm font-semibold text-[var(--ink-2)]">Usual time to sleep</h2>
            <p className="text-6xl font-extrabold tabular-nums leading-none tracking-tight text-[var(--ink)] lg:text-7xl">
              {r.medianTimeToSleepMs !== null ? fmtDuration(r.medianTimeToSleepMs) : "—"}
            </p>
            <p className="text-[13px] text-[var(--ink-2)]">
              {r.nights > 0
                ? `The middle of the nights it timed. ${pluralNights(r.nights)} since ${new Date(nights[0].startedAt).toLocaleDateString([], { month: "short", day: "numeric" })}${watched.length ? `, ${watched.length} from your watch` : ""}.`
                : "The middle of the nights it timed. None yet."}
            </p>
          </div>
          {recent.length >= 3 && (
            <figure className="mt-5 lg:mt-0 lg:w-80">
              <div className="flex h-16 items-end gap-1" role="img" aria-label={`Time to sleep, your last ${recent.length} timed nights: ${recent.map((n) => fmtDuration(n.timeToSleepMs!)).join(", ")}`}>
                {recent.map((n, i) => (
                  <span
                    key={n.startedAt}
                    className="flex-1 rounded-t-[3px] bg-[var(--accent)]"
                    style={{ height: `${Math.max(6, (n.timeToSleepMs! / recentMax) * 100)}%`, opacity: i === recent.length - 1 ? 1 : 0.55 }}
                  />
                ))}
              </div>
              <figcaption className="mt-1.5 flex justify-between text-[11px] text-[var(--ink-3)]">
                <span>Last {recent.length} timed nights</span>
                <span>Latest</span>
              </figcaption>
            </figure>
          )}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--line)] pt-4">
          <div>
            <dt className="text-xs font-semibold text-[var(--ink-3)]">Fastest</dt>
            <dd className="text-2xl font-extrabold tabular-nums tracking-tight text-[var(--ink)]">{r.bestTimeToSleepMs !== null ? fmtDuration(r.bestTimeToSleepMs) : "—"}</dd>
            <dd className="text-[11px] text-[var(--ink-3)]">Your quickest night so far</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-[var(--ink-3)]">Nights you drifted off</dt>
            <dd className="text-2xl font-extrabold tabular-nums tracking-tight text-[var(--ink)]">
              {r.nightsSlept}{r.nights ? <small className="ml-1 text-sm font-semibold text-[var(--ink-3)]">/ {r.nights}</small> : null}
            </dd>
            <dd className="text-[11px] text-[var(--ink-3)]">Nights it saw you go quiet</dd>
          </div>
        </dl>
      </section>

      {/* Chips, as in Podcasts: the whole tab, or one part of it. */}
      {nights.length > 0 && (
        <div role="group" aria-label="Show" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${filter === f.key ? "bg-[var(--accent)] text-[var(--accent-ink)]" : "bg-[var(--raised)] text-[var(--ink)]"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className={filter === "all" ? "space-y-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-6 lg:space-y-0" : "mx-auto max-w-3xl space-y-4"}>
      <div className="space-y-4 empty:hidden">
      {/* The watch measured last night: nothing to ask, only to show. With
          its stages kept, the chart says it, for any night the watch saw. */}
      {watched.length > 0 ? (
        <>
          {show("nights") && <NightChart key={imports} nights={watched} feedTitles={feedTitles} />}
          {show("nights") && <NightsTrend nights={watched} feedTitles={feedTitles} />}
          {show("insights") && <WakeAudit nights={watched} />}
        </>
      ) : nights.length > 0 && show("nights") && (
        // Nothing to chart yet: say why, and take the watch's sleep here.
        <section aria-labelledby="chart-empty-title" className="space-y-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 id="chart-empty-title" className="text-lg font-bold tracking-tight text-[var(--ink)]">Your nights, charted</h2>
          <p className="text-[13px] text-[var(--ink-2)]">
            {nights.some((n) => n.detector === "hr")
              ? "Your watch's sleep came in before Sleepcast kept the stages, so those nights have no chart. Run the watch Shortcut again: it charts the nights it covers."
              : "With your watch's sleep, each night is charted here: when you fell asleep and woke, REM, Core and Deep, against what played. Set up the Shortcut in Settings, under Sleep from your watch."}
          </p>
          <p className="text-xs text-[var(--ink-3)]">Using Sleepcast from your Home Screen? Run the Shortcut, then come back here and add what it copied.</p>
          <button
            onClick={() => { void addWatchFromClipboard(); }}
            className="w-full rounded-full bg-[var(--raised)] py-2.5 text-sm font-bold text-[var(--ink-2)] hover:text-[var(--ink)]"
          >
            Add from clipboard
          </button>
          <p role="alert" className="text-xs text-[var(--danger)] empty:hidden">{watchNote?.error ? watchNote.text : ""}</p>
          <p role="status" className="text-xs text-[var(--ink-3)] empty:hidden">{watchNote && !watchNote.error ? watchNote.text : ""}</p>
        </section>
      )}
      </div>
      {/* Beside the charts on a wide screen, under them on a phone: what
          puts you under first. */}
      <div className="flex flex-col gap-4">
      {scored.length > 0 && show("shows") && (
        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-bold tracking-tight text-[var(--ink)]">What puts you under</h2>
          {/* counted first, so this list never names a different leader than
              the suggestion card just did — same predicate, same order. */}
          {counted.length > 0 && (
            <ul className="mt-3 space-y-3">{counted.map((f, i) => feedRow(f, i + 1))}</ul>
          )}
          {notYetCounted.length > 0 && (
            <div className={counted.length > 0 ? "mt-4" : "mt-2"}>
              <p className="text-xs font-semibold text-[var(--ink-3)]">Not counted for the suggestion yet</p>
              <ul className="mt-3 space-y-3">{notYetCounted.map((f) => feedRow(f, null))}</ul>
            </div>
          )}
          <p className="mt-4 text-[11px] leading-snug text-[var(--ink-3)]">
            {`Ranked by what was playing when you went under. Shows with fewer than ${MIN_NIGHTS} nights, that have never led, or that net negative aren't counted yet.`}
            {favorWhatWorks
              ? ` "Favour what puts me under" is on: a show with ${MIN_NIGHTS} or more nights, counted or not, weighs by its record against the other shows in a night's lineup; a show with fewer nights weighs ×1, and shows that weigh the same lean nothing between them. A weight applies to each fresh episode, so a show with more of them still comes up more. A show that won an experiment weighs ×${WEIGHT_MAX.toFixed(2)}, the most a show can, and the show it beat no more than ×1, whatever their records: an experiment's nights were given at random, so it's the better evidence. Weights other than ×1 are listed for shows that are switched on.`
              : ""}
          </p>
        </section>
      )}
      {show("insights") && <RestedLinks nights={nights} />}
      {nights.length > 0 && show("shows") && <Experiments nights={nights} feeds={feeds} favoring={favorWhatWorks} learning={learnTimer} />}
      {/* The guess for nights without the watch, tuned on nights with it. */}
      {accuracy && show("insights") && (
        <section aria-labelledby="guess-title" className="space-y-1.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 id="guess-title" className="text-lg font-bold tracking-tight text-[var(--ink)]">Sleepcast&apos;s own guess</h2>
          <p className="text-[13px] text-[var(--ink-2)]">
            {accuracy.applied
              ? `Tuned to your watch over ${pluralNights(accuracy.nights)}: you fall asleep about ${fmtDuration(Math.abs(accuracy.correctionMs))} ${accuracy.correctionMs >= 0 ? "after" : "before"} it would have guessed, so its guess now moves ${accuracy.correctionMs >= 0 ? "later" : "earlier"} by that.`
              : `Checked against your watch over ${pluralNights(accuracy.nights)}: moving its guess wouldn't make it closer, so it's left as it is.`}
          </p>
          <p className="text-xs text-[var(--ink-3)]">
            {accuracy.applied
              ? `It was off by about ${fmtDuration(accuracy.beforeMs)} a night; tuned, about ${fmtDuration(accuracy.afterMs)}. It's what you'll see on nights you don't wear the watch.`
              : `It's off by about ${fmtDuration(accuracy.beforeMs)} a night.`}
          </p>
        </section>
      )}
      {last && last.detector === "hr" && !last.watchSleep && show("nights") && (
        <div className="space-y-1.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-bold tracking-tight text-[var(--ink)]">Last night, from your watch</h2>
          <p className="text-[13px] text-[var(--ink-2)]">
            {describeWatchNight({
              watchSleptAfterMs: last.watchSleptAfterMs ?? null,
              sleptAtMs: last.sleptAtMs,
              appSleptAtMs: last.appSleptAtMs ?? null,
              playedMs: last.playedMs ?? null,
            })}
          </p>
        </div>
      )}

      {last && (last.sleptAtMs !== null || last.restartedAfter) && last.selfLabel === undefined && last.detector !== "hr" && show("nights") && (
        <div className="space-y-2.5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-bold tracking-tight text-[var(--ink)]">Did you fall asleep to it last night?</h2>
          <p className="text-[13px]">Sleepcast guesses from when you stopped touching the screen.</p>
          <div className="flex gap-2">
            <button onClick={() => label("slept")} className="rounded-full bg-[var(--raised)] px-4 py-1.5 text-sm font-semibold text-[var(--ink)]">I fell asleep</button>
            <button onClick={() => label("awake")} className="rounded-full bg-[var(--raised)] px-4 py-1.5 text-sm font-semibold text-[var(--ink)]">I was awake</button>
          </div>
          <p className="text-xs">Your answer tunes how quickly it decides you&apos;re asleep.</p>
        </div>
      )}


      {lastPlays.length > 0 && show("nights") && (
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
          <h2 className="text-lg font-bold tracking-tight text-[var(--ink)]">What played last night</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {lastPlays.map((p) => (
              <li key={p.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[var(--ink-2)]">{p.title || "an episode"}</span>
                  <span className="shrink-0 text-xs text-[var(--ink-3)]">
                    {Math.max(1, Math.round(p.heardSec / 60))} min
                  </span>
                </div>
                {driftedDuring?.id === p.id && (
                  <div className="mt-0.5 text-xs font-semibold text-[var(--accent-text)]">you drifted off here</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Outside the scored section: timed nights stay comparable even when
          no feed has scored nights (slept nights with no feed attributed). */}
      {/* The headline's measure split by lean, so formatted like it (fmtDuration). */}
      {compared && show("shows") && (
        <p className="text-[11px] leading-snug text-[var(--ink-3)]">
          {`How long you usually take: ${orDash(compared.leaned.medianMs, fmtDuration)} on nights the shuffle leaned (${pluralNights(compared.leaned.timedNights, "timed")}), ${orDash(compared.plain.medianMs, fmtDuration)} on plain-shuffle nights (${pluralNights(compared.plain.timedNights, "timed")}). A rough guide: the two differ in more than the lean (which shows, which weeks).`}
        </p>
      )}
      </div>
      </div>
      <p className="text-center text-xs text-[var(--ink-4)]">
        counted only on this device. no account, nothing sent anywhere. we're
        rooting for the nights you don't need us.
      </p>
      {onClose && <button onClick={onClose} className="text-xs underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]">back</button>}
    </div>
  );
}

/** A median through `fmt`, or "—" when there is none. */
function orDash(ms: number | null, fmt: (ms: number) => string): string {
  return ms === null ? "—" : fmt(ms);
}
