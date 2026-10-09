import { useMemo, useState } from "react";
import { loadNights, lastOf, rollup, setSelfLabel, leanComparison, offerForLabel } from "../lib/rest/ledger";
import { recordFalsePositive } from "../lib/rest/calibrate";
import { scoreFeeds, medianTimeToSleep, meetsSuggestionGate, shuffleWeights, pluralNights, fmtOnsetMinutes, MIN_NIGHTS } from "../lib/rest/sleepscore";
import { getPlays, loadState } from "../lib/store";
import { playsSince, playAtMoment } from "../lib/plays";
import { importWatch, isRefused, payloadFromPaste, watchAgreement, watchNotice } from "../lib/rest/watch";
import { WatchLine } from "./WatchLine";

/** `onClose(changed)`: changed when a paste altered what the home screen
 *  works its lines out from, which the caller reloads to read again. */
export function RestView({ onClose }: { onClose: (changed?: boolean) => void }) {
  // Re-read after a pasted watch import re-times them.
  const [nights, setNights] = useState(() => loadNights());
  const watch = useMemo(() => watchAgreement(nights), [nights]);
  const [pasted, setPasted] = useState("");
  const [pasteLine, setPasteLine] = useState<string | null>(null);
  // A pasted import may change what the home screen worked out its lines
  // from: re-timed nights (the goodbye, the step-back offer), or a killed
  // tab's night recorded first (the resume offer). Leaving then says so, and
  // the page reloads to read them again, as the link's import does.
  const [changedHere, setChangedHere] = useState(false);
  function importPasted() {
    const r = importWatch(payloadFromPaste(pasted));
    setPasteLine(watchNotice(r));
    // Kept when refused or not saved, so it can be looked at or tried again.
    if (!isRefused(r)) setPasted("");
    if (r.nights) {
      setNights(r.nights);
      setChangedHere(true);
    }
  }
  const close = () => onClose(changedHere);
  const r = useMemo(() => rollup(nights), [nights]);
  const last = lastOf(nights);

  // Only custom feeds can go missing from here — loadState always re-merges
  // every BUILTIN_FEEDS entry regardless of what's saved, and removeCustomFeed
  // no-ops on builtins. So a lookup miss below is always a removed custom feed.
  // (And whether the shuffle leans: shown per feed while it's on, so the
  // lean is as auditable as the ranking; only for a feed that is on, since
  // setup builds no lineup from a removed or switched-off one. A 3am
  // re-anchor carries the faded night's lineup, so a feed switched off since
  // can still lean that one night, unlisted.)
  const { feedTitles, enabledFeeds, favorWhatWorks } = useMemo(() => {
    const s = loadState();
    return {
      feedTitles: Object.fromEntries(s.feeds.map((f) => [f.id, f.title])),
      enabledFeeds: new Set(s.feeds.filter((f) => f.enabled).map((f) => f.id)),
      favorWhatWorks: s.settings.favorWhatWorks,
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
  const leanOf = useMemo(() => (favorWhatWorks ? shuffleWeights(scored) : null), [scored, favorWhatWorks]);
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
  // The episode running at the moment you went under. A watch onset was
  // attributed from the night's own timeline, which knows when the audio
  // was dead (after the end, or before a revive): its episode or none. The
  // play ledger can't tell, so it only answers for the detector's onset.
  const driftedDuring = useMemo(() => {
    if (!last || last.sleptAtMs === null) return null;
    const credited = last.onsetEpisodeId !== undefined ? lastPlays.find((p) => p.id === last.onsetEpisodeId) : undefined;
    if (credited) return credited;
    // Not among the plays (one only counts after HEARD_SEC), or no
    // attribution: a watch night's onset may be when nothing was playing,
    // so none; a detector night falls back on the plays, as it always did.
    return last.detector === "watch" ? null : playAtMoment(lastPlays, last.startedAt + last.sleptAtMs);
  }, [lastPlays, last]);

  // Shared row markup so the two groups below (counted / not-yet-counted)
  // can never drift apart in what they show per feed.
  function feedRow(f: (typeof scored)[number]) {
    const median = medianTimeToSleep(nights, f.feedId);
    const lean = enabledFeeds.has(f.feedId) ? leanOf?.(f.feedId) : undefined;
    return (
      <li key={f.feedId} className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="flex-1 truncate text-[#b0a898]">
          {/* Raw ids for builtins ("swm") are readable enough to ship;
              a removed custom feed's id ("custom-1699999999-ab3f2")
              is not, so a title-less feed gets a plain label instead
              of leaking that internal id into the UI. */}
          {feedTitles[f.feedId] ?? "a show you removed"}
        </span>
        <span className="shrink-0 text-xs text-[#8a7a5c]">
          {/* Worded as the evidence sentence words it, so the two can be checked against each other. */}
          {orDash(median, fmtOnsetMinutes)}
        </span>
        <span className="shrink-0 text-[10px] text-[#4a4540]">
          {pluralNights(f.nights)}
          {f.skipNights > 0 ? ` · ${f.skipNights} skipped` : ""}
        </span>
        {/* On its own line, so the title keeps its room at phone width.
            Relative: the shuffle weighs a night's lineup against itself. */}
        {lean !== undefined && lean !== 1 && (
          <span className="w-full text-right text-[10px] text-[#4a4540]">{`weighs ×${lean.toFixed(2)}`}</span>
        )}
      </li>
    );
  }

  function label(kind: "slept" | "awake") {
    if (!last) return;
    const labelled = setSelfLabel(last.startedAt, kind);
    // a confirmed false positive tightens the detector for next time
    if (labelled && kind === "awake" && labelled.sleptAtMs !== null) {
      recordFalsePositive();
    }
    close();
  }

  return (
    <div className="mx-auto max-w-sm space-y-8 px-6 py-16 text-center text-[#8a7a5c]">
      <div>
        <div className="text-5xl text-[#c8c0b0]">{r.nightsSlept}</div>
        <div className="mt-1 text-xs uppercase tracking-widest">nights you drifted off</div>
      </div>
      {r.bestTimeToSleepMs !== null && (
        <div>
          <div className="text-2xl text-[#b0a898]">{fmtOnsetMinutes(r.bestTimeToSleepMs)}</div>
          <div className="mt-1 text-xs uppercase tracking-widest">fastest you left us</div>
        </div>
      )}
      {r.medianTimeToSleepMs !== null && (
        <div>
          <div className="text-2xl text-[#b0a898]">{fmtOnsetMinutes(r.medianTimeToSleepMs)}</div>
          <div className="mt-1 text-xs uppercase tracking-widest">how long you usually take</div>
        </div>
      )}
      {lastPlays.length > 0 && (
        <div className="border-t border-[#241f30] pt-6 text-left">
          <div className="text-center text-xs uppercase tracking-widest">last night</div>
          <ul className="mt-4 space-y-2 text-sm">
            {lastPlays.map((p) => (
              <li key={p.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[#b0a898]">{p.title || "an episode"}</span>
                  <span className="shrink-0 text-xs text-[#6b6255]">
                    {Math.max(1, Math.round(p.heardSec / 60))} min
                  </span>
                </div>
                {driftedDuring?.id === p.id && (
                  <div className="mt-0.5 text-xs text-[#6e5d44]">you drifted off here</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {last && offerForLabel(last) && (
        <div className="space-y-2 border-t border-[#241f30] pt-6 text-sm">
          <p>did you fall asleep to it last time?</p>
          <div className="flex justify-center gap-3">
            <button onClick={() => label("slept")} className="rounded-full border border-[#241f30] px-4 py-1.5 hover:border-[#6e5d44]">yes</button>
            <button onClick={() => label("awake")} className="rounded-full border border-[#241f30] px-4 py-1.5 hover:border-[#6e5d44]">no</button>
          </div>
        </div>
      )}
      {scored.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-widest text-[#4a4540]">
            what puts you under
          </h2>
          {/* counted first, so this list never names a different leader than
              the suggestion card just did — same predicate, same order. */}
          {counted.length > 0 && (
            <ul className="mt-2 space-y-1.5">{counted.map(feedRow)}</ul>
          )}
          {notYetCounted.length > 0 && (
            <div className={counted.length > 0 ? "mt-4" : "mt-2"}>
              <p className="text-[10px] uppercase tracking-widest text-[#4a4540]">
                not counted for the suggestion yet
              </p>
              <ul className="mt-2 space-y-1.5">{notYetCounted.map(feedRow)}</ul>
            </div>
          )}
          <p className="mt-2 text-[11px] leading-snug text-[#4a4540]">
            {`Ranked by what was playing when you went under. Shows with fewer than ${MIN_NIGHTS} nights, that have never led, or that net negative aren't counted yet.`}
            {favorWhatWorks
              ? ` "Favor what puts me under" is on: a show with ${MIN_NIGHTS} or more nights, counted or not, weighs by its record against the other shows in a night's lineup; a show with fewer nights weighs ×1, and shows that weigh the same lean nothing between them. A weight applies to each fresh episode, so a show with more of them still comes up more. Weights other than ×1 are listed for shows that are switched on.`
              : ""}
          </p>
        </section>
      )}
      {/* Outside the scored section: timed nights stay comparable even when
          no feed has scored nights (slept nights with no feed attributed). */}
      {/* The headline's measure split by lean, so formatted like it (fmtOnsetMinutes). */}
      {compared && (
        <p className="text-[11px] leading-snug text-[#8a7a5c]">
          {`How long you usually take: ${orDash(compared.leaned.medianMs, fmtOnsetMinutes)} on nights the shuffle leaned (${pluralNights(compared.leaned.timedNights, "timed")}), ${orDash(compared.plain.medianMs, fmtOnsetMinutes)} on plain-shuffle nights (${pluralNights(compared.plain.timedNights, "timed")}). A rough guide: the two differ in more than the lean (which shows, which weeks).`}
        </p>
      )}
      <section className="space-y-2 border-t border-[#241f30] pt-6 text-xs">
        {watch.watchNights > 0 ? (
          <p>
            {`your watch timed ${pluralNights(watch.watchNights)}.`}
            {watch.medianOffMs !== null
              ? ` sleepcast's own guess was ${fmtOnsetMinutes(watch.medianOffMs)} off it, typically (${pluralNights(watch.compared)} to compare).`
              : ""}
          </p>
        ) : (
          <p>have an apple watch? it can time your nights instead of sleepcast guessing.</p>
        )}
        <a href="/watch" className="block underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">
          set up the watch shortcut
        </a>
        {/* The home-screen app keeps its own storage, apart from Safari's, so
            the Shortcut's link can't reach it: its copy-to-clipboard variant
            is pasted here instead. */}
        <details className="text-left">
          <summary className="cursor-pointer text-center text-[#4a4540] hover:text-[#8a7a5c]">paste from your watch</summary>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={3}
            aria-label="watch sleep data"
            className="mt-2 w-full rounded border border-[#241f30] bg-transparent p-2 text-[11px] text-[#b0a898]"
          />
          <button
            onClick={importPasted}
            disabled={!pasted.trim()}
            className="mt-1 rounded-full border border-[#241f30] px-4 py-1 hover:border-[#6e5d44] disabled:opacity-40"
          >
            read it
          </button>
        </details>
        {pasteLine && (
          <p className="text-[#b0a898]">
            <WatchLine text={pasteLine} />
          </p>
        )}
      </section>
      <p className="text-xs text-[#4a4540]">
        counted only on this device. no account, nothing sent anywhere. we're
        rooting for the nights you don't need us.
      </p>
      <button onClick={close} className="text-xs underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">back</button>
    </div>
  );
}

/** A median through `fmt`, or "—" when there is none. */
function orDash(ms: number | null, fmt: (ms: number) => string): string {
  return ms === null ? "—" : fmt(ms);
}
