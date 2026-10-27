// Nights over time, from the watch (lib/rest/trends.ts): the typical night
// in four figures, each night as a bar on one clock, and how the shows you
// fell asleep to compare.
import type { RestNight } from "../lib/rest/types";
import { byShow, minutesAfterNoon, sleepRecords, typical } from "../lib/rest/trends";
import { fmtLong, stageColor } from "./NightChart";

/** Nights drawn: two weeks. */
const SHOWN = 14;
/** Below this many, the figures come with a warning that they will move. */
const SETTLED = 7;

const W = 320;
const LEFT = 44;
const RIGHT = 8;
const ROW = 12;
const GAP = 7;

/** "11:20 PM" from minutes after noon. */
function clockOf(m: number): string {
  const d = new Date(2000, 0, 1, 12, 0);
  d.setMinutes(d.getMinutes() + Math.round(m));
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const hourOf = (m: number) => {
  const d = new Date(2000, 0, 1, 12, 0);
  d.setMinutes(d.getMinutes() + m);
  return d.toLocaleTimeString([], { hour: "numeric" });
};

export function NightsTrend({ nights, feedTitles }: { nights: RestNight[]; feedTitles: Record<string, string> }) {
  const records = sleepRecords(nights);
  if (records.length < 2) return null;
  const t = typical(records)!;
  const shows = byShow(records);
  const shown = records.slice(-SHOWN).reverse();

  // One clock for every row: from the earliest press of play to the latest
  // waking, whole hours.
  const startOf = (r: (typeof shown)[number]) => minutesAfterNoon(r.startedAt);
  const lo = Math.floor(Math.min(...shown.map(startOf)) / 60) * 60;
  const hi = Math.min(24 * 60, Math.ceil(Math.max(...shown.map((r) => startOf(r) + (r.wokeAt - r.startedAt) / 60_000)) / 60) * 60);
  const x = (m: number) => LEFT + ((Math.min(Math.max(m, lo), hi) - lo) / (hi - lo)) * (W - LEFT - RIGHT);
  const step = hi - lo > 8 * 60 ? 120 : 60;
  const ticks: number[] = [];
  for (let m = lo + step; m < hi; m += step) ticks.push(m);
  const H = shown.length * (ROW + GAP) + 16;

  const day = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric" });

  return (
    <section aria-labelledby="trend-title" className="space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
      <div>
        <h2 id="trend-title" className="text-[11px] font-bold uppercase tracking-widest text-[var(--ink-3)]">your nights</h2>
        <p className="text-[13px] text-[var(--ink-3)]">
          {`The middle of ${t.nights} nights from your watch.`}
          {t.nights < SETTLED ? " Early days: these will move as more nights come in." : ""}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Typ label="Pressed play" value={clockOf(t.bedtime)} />
        <Typ label="Fell asleep" value={clockOf(t.fellAsleep)} note={t.toSleepMs !== null ? `${fmtLong(t.toSleepMs)} after play` : undefined} />
        <Typ label="Woke" value={clockOf(t.woke)} />
        <Typ label="Asleep" value={fmtLong(t.asleepMs)} />
      </dl>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Your last ${shown.length} nights, newest first, from when you pressed play to when you woke.`}
        className="block h-auto w-full max-w-full"
      >
        {ticks.map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={0} y2={H - 14} stroke="var(--line)" />
            <text x={x(m)} y={H - 3} fontSize={9} textAnchor="middle" fill="var(--ink-4)">{hourOf(m)}</text>
          </g>
        ))}
        {shown.map((r, k) => {
          const y = k * (ROW + GAP);
          const base = startOf(r);
          const at = (ms: number) => x(base + ms / 60_000);
          return (
            <g key={r.startedAt}>
              <text x={0} y={y + ROW - 2} fontSize={9.5} fill="var(--ink-3)">{day(r.startedAt)}</text>
              <rect x={x(lo)} y={y} width={x(hi) - x(lo)} height={ROW} rx={2} fill="var(--raised)" />
              {r.stretches.map((s, j) => (
                <rect key={j} x={at(s.from)} y={y} width={Math.max(0.5, at(s.to) - at(s.from))} height={ROW} fill={stageColor(s.stage)} />
              ))}
              {/* What Sleepcast played, under the night it played into. */}
              <rect x={at(0)} y={y + ROW + 1} width={Math.max(1, at(r.playedMs) - at(0))} height={3} rx={1} fill="var(--accent)" />
            </g>
          );
        })}
      </svg>
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--ink-3)]">
        <span aria-hidden className="inline-block h-1 w-4 rounded-sm bg-[var(--accent)]" />
        Sleepcast playing. Stages coloured as in the night above.
      </p>

      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold text-[var(--ink-2)]">By what you fell asleep to</h3>
        {shows.length ? (
          <ul>
            <li aria-hidden className="flex gap-2 text-[10px] uppercase tracking-widest text-[var(--ink-4)]">
              <span className="flex-1">Show</span>
              <span className="w-20 text-right">To sleep</span>
              <span className="w-20 text-right">Asleep</span>
            </li>
            {shows.map((s) => (
              <li key={s.feedId} className="flex items-baseline gap-2 border-t border-[var(--line)] py-1.5 text-sm">
                <span className="min-w-0 flex-1 text-[var(--ink-2)]">
                  {feedTitles[s.feedId] ?? "a show you removed"}
                  <span className="block text-[10px] text-[var(--ink-4)]">{`${s.nights} nights`}</span>
                </span>
                <span className="w-20 text-right tabular-nums text-[var(--ink-2)]"><span className="sr-only">to sleep </span>{fmtLong(s.toSleepMs)}</span>
                <span className="w-20 text-right tabular-nums text-[var(--ink-2)]"><span className="sr-only">asleep </span>{fmtLong(s.asleepMs)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--ink-3)]">A show appears here once you&apos;ve fallen asleep to it on 2 nights your watch saw.</p>
        )}
        <p className="text-[11px] leading-snug text-[var(--ink-4)]">
          The middle night for each show. A rough guide: shows also differ in which nights they got.
        </p>
      </div>
    </section>
  );
}

function Typ({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--ink-3)]">{label}</dt>
      <dd className="text-lg font-extrabold tabular-nums tracking-tight text-[var(--ink)]">{value}</dd>
      {note && <dd className="text-[11px] text-[var(--ink-3)]">{note}</dd>}
    </div>
  );
}
