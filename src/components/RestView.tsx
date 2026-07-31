import { useMemo } from "react";
import { loadNights, rollup, setSelfLabel, loadParams, saveParams } from "../lib/rest/ledger";
import { tightenAfterFalsePositive } from "../lib/rest/calibrate";
import { fmtDuration, lastNight } from "../lib/rest/surface";
import { getPlays } from "../lib/store";
import { playsSince, playAtMoment } from "../lib/plays";

export function RestView({ onClose }: { onClose: () => void }) {
  const nights = useMemo(() => loadNights(), []);
  const r = useMemo(() => rollup(nights), [nights]);
  const last = lastNight();

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
      <p className="text-xs text-[#4a4540]">
        counted only on this device. no account, nothing sent anywhere. we're
        rooting for the nights you don't need us.
      </p>
      <button onClick={onClose} className="text-xs underline decoration-[#3a3325] underline-offset-4 hover:text-[#b59a76]">back</button>
    </div>
  );
}
