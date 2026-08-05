import { useMemo } from "react";
import { loadNights, rollup, setSelfLabel, loadParams, saveParams } from "../lib/rest/ledger";
import { tightenAfterFalsePositive } from "../lib/rest/calibrate";
import { scoreFeeds, medianTimeToSleep } from "../lib/rest/sleepscore";
import { fmtDuration, lastNight } from "../lib/rest/surface";
import { getPlays, loadState } from "../lib/store";
import { playsSince, playAtMoment } from "../lib/plays";

export function RestView({ onClose }: { onClose: () => void }) {
  const nights = useMemo(() => loadNights(), []);
  const r = useMemo(() => rollup(nights), [nights]);
  const last = lastNight();

  // Only custom feeds can go missing from here — loadState always re-merges
  // every BUILTIN_FEEDS entry regardless of what's saved, and removeCustomFeed
  // no-ops on builtins. So a lookup miss below is always a removed custom feed.
  const feedTitles = useMemo(() => {
    const s = loadState();
    return Object.fromEntries(s.feeds.map((f) => [f.id, f.title]));
  }, []);

  // scoreFeeds, not rankedFeeds: the panel shows everything including feeds
  // below the suggestion threshold. Its whole job is to be auditable, and
  // hiding the thin evidence would defeat that.
  const scored = useMemo(() => scoreFeeds(nights), [nights]);

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

  function label(kind: "slept" | "awake") {
    if (!last) return;
    setSelfLabel(last.startedAt, kind);
    // a confirmed false positive tightens the detector for next time
    if (kind === "awake" && last.sleptAtMs !== null) {
      const p = loadParams();
      if (p) saveParams(tightenAfterFalsePositive(p));
    }
    onClose();
  }

  return (
    <div className="mx-auto max-w-sm space-y-8 px-6 py-16 text-center text-[#8a7a5c]">
      <div>
        <div className="text-5xl text-[#c8c0b0]">{r.nightsSlept}</div>
        <div className="mt-1 text-xs uppercase tracking-widest">nights you drifted off</div>
      </div>
      {r.bestTimeToSleepMs !== null && (
        <div>
          <div className="text-2xl text-[#b0a898]">{fmtDuration(r.bestTimeToSleepMs)}</div>
          <div className="mt-1 text-xs uppercase tracking-widest">fastest you left us</div>
        </div>
      )}
      {r.medianTimeToSleepMs !== null && (
        <div>
          <div className="text-2xl text-[#b0a898]">{fmtDuration(r.medianTimeToSleepMs)}</div>
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
      {last && last.sleptAtMs !== null && last.selfLabel === undefined && (
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
          <ul className="mt-2 space-y-1.5">
            {scored.map((f) => {
              const median = medianTimeToSleep(nights, f.feedId);
              return (
                <li key={f.feedId} className="flex items-baseline gap-2 text-sm">
                  <span className="flex-1 truncate text-[#b0a898]">
                    {/* Raw ids for builtins ("swm") are readable enough to ship;
                        a removed custom feed's id ("custom-1699999999-ab3f2")
                        is not, so a title-less feed gets a plain label instead
                        of leaking that internal id into the UI. */}
                    {feedTitles[f.feedId] ?? "a feed you removed"}
                  </span>
                  <span className="shrink-0 text-xs text-[#8a7a5c]">
                    {median === null ? "—" : `${Math.round(median / 60_000)} min`}
                  </span>
                  <span className="shrink-0 text-[10px] text-[#4a4540]">
                    {f.nights} night{f.nights === 1 ? "" : "s"}
                    {f.skipNights > 0 ? ` · ${f.skipNights} skipped` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-[#4a4540]">
            Ranked by what was playing when you went under. Feeds with fewer
            than three nights are listed but never suggested.
          </p>
        </section>
      )}
      <p className="text-xs text-[#4a4540]">
        counted only on this device. no account, nothing sent anywhere. we're
        rooting for the nights you don't need us.
      </p>
      <button onClick={onClose} className="text-xs underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">back</button>
    </div>
  );
}
