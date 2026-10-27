// A night from the watch, drawn: its sleep stages over the hours, and under
// them what Sleepcast did (what played, when you touched the phone, its own
// guess), so the two can be read against each other.
import { useState } from "react";
import type { RestNight, SleepStage } from "../lib/rest/types";
import { describeWatchNight, summarizeStages } from "../lib/rest/watch";
import { eventsWhileAsleep } from "../lib/rest/wakes";

const STAGES: { stage: SleepStage; label: string }[] = [
  { stage: "awake", label: "Awake" },
  { stage: "rem", label: "REM" },
  { stage: "core", label: "Core" },
  { stage: "deep", label: "Deep" },
];
const UNSTAGED: { stage: SleepStage; label: string }[] = [
  { stage: "awake", label: "Awake" },
  { stage: "asleep", label: "Asleep" },
];

const W = 320;
const LEFT = 50;
const RIGHT = 8;
const ROW = 16;
const GAP = 4;
const HOUR = 60 * 60_000;

/** A watch that doesn't tell the stages apart draws its sleep in Core's hue. */
export const stageColor = (s: SleepStage) => `var(--stage-${s === "asleep" ? "core" : s})`;

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourLabel = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric" });

/** "6 h 52 min", "48 min". */
export function fmtLong(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** `nights`: the ones with watchSleep, oldest first; the latest shows first. */
export function NightChart({ nights, feedTitles }: { nights: RestNight[]; feedTitles: Record<string, string> }) {
  const [i, setI] = useState(nights.length - 1);
  // The whole night, or zoomed in on the part of it Sleepcast played through,
  // which is a sliver of a whole night's width.
  const [zoom, setZoom] = useState(false);
  const n = nights[Math.min(i, nights.length - 1)];
  if (!n?.watchSleep) return null;
  const stretches = n.watchSleep;
  const sum = summarizeStages(stretches);
  const rows = sum?.staged === false ? UNSTAGED : STAGES;
  // An unstaged "asleep" among staged ones (another source's) sits with Core.
  const shown = (s: SleepStage): SleepStage => (s === "asleep" && rows === STAGES ? "core" : s);
  const rowOf = (s: SleepStage) => Math.max(0, rows.findIndex((r) => r.stage === shown(s)));

  const played = n.playedMs ?? 0;
  const touches = n.touchedAt ?? [];
  const onset = n.watchSleptAfterMs ?? null;
  const guess = n.appSleptAtMs ?? null;
  const whole = Math.max(stretches[stretches.length - 1]?.to ?? 0, played, ...touches, 30 * 60_000);
  const span = zoom ? Math.min(whole, Math.max(played, onset ?? 0, guess ?? 0, ...touches) + 15 * 60_000) : whole;
  const x = (t: number) => LEFT + (Math.min(Math.max(t, 0), span) / span) * (W - LEFT - RIGHT);

  const stagesH = rows.length * (ROW + GAP);
  const touchY = stagesH + 6;
  const playY = touchY + 12;
  const axisY = playY + 12 + 14;
  const H = axisY + 4;

  // Marks on the clock, as many as fit: every other hour on a long night,
  // down to every quarter hour zoomed in.
  const step = span > 9 * HOUR ? 2 * HOUR : span > 2 * HOUR ? HOUR : span > 75 * 60_000 ? HOUR / 2 : HOUR / 4;
  const first = new Date(n.startedAt);
  first.setMinutes(0, 0, 0);
  const ticks: number[] = [];
  // Not so near the right edge that the label is cut off.
  const lastTick = n.startedAt + span * (1 - 24 / (W - LEFT - RIGHT));
  for (let t = first.getTime() + step; t <= lastTick; t += step) if (t > n.startedAt) ticks.push(t);
  const tickLabel = step < HOUR ? clock : hourLabel;

  const eps = [...(n.episodes ?? [])].filter((e) => e.t < played).sort((a, b) => a.t - b.t);
  const segments = eps.length
    ? eps.map((e, k) => ({ from: e.t, to: Math.min(eps[k + 1]?.t ?? played, played), title: feedTitles[e.feedId] ?? "a show you removed" }))
    : played > 0 ? [{ from: 0, to: played, title: "" }] : [];

  // What Sleepcast did while you slept that you woke soon after (wakes.ts).
  const wokeAfter = eventsWhileAsleep(n).filter((e) => e.woke);
  const date = new Date(n.startedAt).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

  const summary = sum
    ? `Asleep ${fmtLong(sum.asleepMs)}, from ${clock(n.startedAt + sum.fellAsleepMs)} to ${clock(n.startedAt + sum.wokeMs)}. Sleepcast played for ${fmtLong(played)}.`
    : `Your watch saw no sleep this night. Sleepcast played for ${fmtLong(played)}.`;

  return (
    <section aria-labelledby="night-chart-title" className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 id="night-chart-title" className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">from your watch</h2>
          <p className="font-semibold text-[var(--ink)]">{date}</p>
        </div>
        {nights.length > 1 && (
          <div className="flex shrink-0 gap-1">
            <button onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} aria-label="Earlier night" className="rounded-lg bg-[var(--raised)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-2)] disabled:opacity-40">‹</button>
            <button onClick={() => setI(Math.min(nights.length - 1, i + 1))} disabled={i >= nights.length - 1} aria-label="Later night" className="rounded-lg bg-[var(--raised)] px-3 py-1.5 text-sm font-semibold text-[var(--ink-2)] disabled:opacity-40">›</button>
          </div>
        )}
      </div>

      {sum && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="Asleep" value={fmtLong(sum.asleepMs)} />
          <Stat label="Fell asleep" value={clock(n.startedAt + sum.fellAsleepMs)} note={`${fmtLong(sum.fellAsleepMs)} after play`} />
          <Stat label="Woke" value={clock(n.startedAt + sum.wokeMs)} />
          {sum.wakings ? (
            <Stat label="Awake in the night" value={fmtLong(sum.awakeMs)} note={sum.wakings === 1 ? "once" : `${sum.wakings} times`} />
          ) : (
            <Stat label="Awake in the night" value="Never" />
          )}
        </dl>
      )}

      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="block h-auto w-full max-w-full">
        {rows.map((r, k) => (
          <g key={r.stage}>
            <rect x={LEFT} y={k * (ROW + GAP)} width={W - LEFT - RIGHT} height={ROW} rx={3} fill="var(--raised)" />
            <text x={0} y={k * (ROW + GAP) + ROW - 4} fontSize={10} fill="var(--ink-3)">{r.label}</text>
          </g>
        ))}
        {stretches.filter((s) => s.from < span).map((s, k) => (
          <rect key={k} x={x(s.from)} y={rowOf(s.stage) * (ROW + GAP)} width={Math.max(1, x(s.to) - x(s.from))} height={ROW} rx={2} fill={stageColor(s.stage)}>
            <title>{`${STAGES.find((r) => r.stage === s.stage)?.label ?? "Asleep"}, ${clock(n.startedAt + s.from)} to ${clock(n.startedAt + s.to)}`}</title>
          </rect>
        ))}

        <text x={0} y={touchY + 7} fontSize={10} fill="var(--ink-3)">Touched</text>
        {touches.map((t, k) => (
          <rect key={k} x={x(t) - 0.75} y={touchY} width={1.5} height={8} fill="var(--ink-2)" />
        ))}

        <text x={0} y={playY + 9} fontSize={10} fill="var(--ink-3)">Played</text>
        {segments.map((s, k) => (
          <rect key={k} x={x(s.from)} y={playY} width={Math.max(1, x(s.to) - x(s.from) - 1)} height={10} rx={2} fill="var(--accent)" opacity={k % 2 ? 0.6 : 1}>
            <title>{`${s.title ? `${s.title}, ` : ""}${clock(n.startedAt + s.from)} to ${clock(n.startedAt + s.to)}`}</title>
          </rect>
        ))}

        {wokeAfter.filter((e) => e.t <= span).map((e) => (
          <path key={e.t} d={`M ${x(e.t)} ${playY - 1} l -4 -6 h 8 z`} fill="var(--danger)">
            <title>{`You woke soon after ${e.cause === "episode" ? "a new episode started" : "the sound stopped"}, at ${clock(n.startedAt + e.t)}`}</title>
          </path>
        ))}
        {wokeAfter.length > 0 && (
          <li className="flex items-center gap-1"><svg aria-hidden width="8" height="6" className="inline-block"><path d="M 4 6 L 0 0 H 8 Z" fill="var(--danger)" /></svg>Woke soon after this</li>
        )}
        {guess !== null && (
          <line x1={x(guess)} x2={x(guess)} y1={0} y2={playY + 10} stroke="var(--accent-text)" strokeWidth={1.5} strokeDasharray="3 2" />
        )}
        {onset !== null && (
          <line x1={x(onset)} x2={x(onset)} y1={0} y2={playY + 10} stroke="var(--ink)" strokeWidth={1.5} />
        )}

        <line x1={LEFT} x2={W - RIGHT} y1={axisY - 12} y2={axisY - 12} stroke="var(--line)" />
        {ticks.map((t) => {
          const tx = x(t - n.startedAt);
          return (
            <g key={t}>
              <line x1={tx} x2={tx} y1={axisY - 14} y2={axisY - 10} stroke="var(--ink-4)" />
              <text x={tx} y={axisY} fontSize={9} textAnchor="middle" fill="var(--ink-4)">{tickLabel(t)}</text>
            </g>
          );
        })}
      </svg>

      {played > 0 && whole > 2 * played && (
        <button onClick={() => setZoom(!zoom)} aria-pressed={zoom} className="text-xs text-[var(--ink-3)] underline decoration-[var(--line)] underline-offset-4 hover:text-[var(--ink-2)]">
          {zoom ? "Show the whole night" : "Zoom in on when it played"}
        </button>
      )}

      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--ink-3)]">
        {sum && rows.filter((r) => r.stage !== "awake").map((r) => (
          <li key={r.stage} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: stageColor(r.stage) }} />
            {`${r.label} ${fmtLong(r.stage === "core" ? (sum.byStage.core ?? 0) + (sum.byStage.asleep ?? 0) : sum.byStage[r.stage] ?? 0)}`}
          </li>
        ))}
        {onset !== null && (
          <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-0.5 bg-[var(--ink)]" />Asleep, by your watch</li>
        )}
        {wokeAfter.length > 0 && (
          <li className="flex items-center gap-1"><svg aria-hidden width="8" height="6" className="inline-block"><path d="M 4 6 L 0 0 H 8 Z" fill="var(--danger)" /></svg>Woke soon after this</li>
        )}
        {guess !== null && (
          <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-0 border-l-2 border-dashed border-[var(--accent-text)]" />Sleepcast&apos;s guess</li>
        )}
      </ul>

      <p className="text-[13px] text-[var(--ink-2)]">
        {describeWatchNight({ watchSleptAfterMs: onset, sleptAtMs: n.sleptAtMs, appSleptAtMs: guess, playedMs: n.playedMs ?? null })}
      </p>

      {segments.some((s) => s.title) && (
        <ul className="space-y-0.5 text-xs text-[var(--ink-3)]">
          {segments.map((s, k) => (
            <li key={k} className="flex gap-2"><span className="w-16 shrink-0 tabular-nums">{clock(n.startedAt + s.from)}</span><span className="truncate text-[var(--ink-2)]">{s.title}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--ink-3)]">{label}</dt>
      <dd className="text-lg font-extrabold tabular-nums tracking-tight text-[var(--ink)]">{value}</dd>
      {note && <dd className="text-[11px] text-[var(--ink-3)]">{note}</dd>}
    </div>
  );
}
