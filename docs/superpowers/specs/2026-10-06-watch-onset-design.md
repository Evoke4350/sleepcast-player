# Apple Watch onsets, through an iOS Shortcut

## 1. Why

Sleepcast infers sleep onset from the phone going still (the detector,
rest/detector.ts). It is a guess, it can only decide once the timer fades, and
a night the tab spent backgrounded is often recorded with no onset at all. An
Apple Watch with sleep tracking records sleep stages. Bringing those in times
nights by measurement, credits the right show in "what puts you under", and,
for the first time, tells the listener (and us) how far off the detector is.

## 2. Shape

An iOS Shortcut, built once by the listener (steps on /watch), reads the last
two days of the watch's own Sleep Analysis samples from Health (filtered by
source, so another sleep app's coarser samples can't blur them) and opens
`https://sleepcast.pro/#watch=<samples>`. The fragment is never sent to a
server, so the samples go from Health to the browser's storage and nowhere
else. No account, no endpoint, no native build.

Payload: one sample per line, `start~end~stage`, ISO 8601 dates with time, the
stage as Health names it (Core, Deep, REM, Asleep, Awake, In Bed, matched as
whole names) or its numeric code (HKCategoryValueSleepAnalysis 0–5). English
names only, and any unrecognised name refuses the whole import: in several
languages REM is still "REM" while the other stages aren't English, and the
recognised part alone would time the night from its first REM stage. A line
whose dates lack a time or don't parse (or whose end comes first) is
malformed and reported. The newest 2000 lines are read.

A home-screen copy of the site keeps its own storage, apart from Safari's, so
the link can't reach it. For that, the Shortcut copies the lines instead, and
the rest view has a "paste from your watch" box (it accepts the lines or the
whole link).

## 3. Matching

Asleep samples (Core, Deep, REM, Asleep) are merged into stretches of sleep
where one begins within a minute of the last's end. A night's watch onset is
the start of the first stretch that begins at or after the night's start,
within `MATCH_WINDOW_MS` (4 h) and before the next night's start (a 3am
re-anchor is its own night). A stretch that began before the night's start
doesn't count, nor does a stage change within it: the listener was awake to
press start. Nor does a stretch beginning at the payload's very first sample:
the window ("last 2 days") may have cut off its earlier stages, so its start
could be a stage change. (A first-ever night with nothing before its sleep in
the payload is timed by the next morning's run instead.)

## 4. Re-timing

A matched night becomes `detector: "watch"`, `sleptAtMs`/`timeToSleepMs` the
watch's onset, and keeps the detector's onset as `inferredAtMs` (null when it
found none). Re-importing is idempotent: `inferredAtMs` keeps the detector's
original. A night the watch already timed at the same onset is left alone
and counted as unchanged, not re-timed (the Shortcut reads two days, so each
morning re-reads the night before).

Attribution (onset feed and episode, `onsetAfterMs`, `sleptThrough`) is redone
from the night's `timeline` with the same function `RestSession.finish` uses
(`attribution`, session.ts). To make that possible, nights now record:

- `timeline`: the night's episode starts, kept `TIMELINE_KEEP_MS` (7 days) and
  pruned as nights are appended, so 90 nights of episode ids don't crowd
  storage;
- `endedAt`: an onset after the night ended credits no show (the audio had
  stopped). A night reconciled from a killed tab ends when it was last seen
  alive, not at its scheduled fade: nothing after was observed.

A timeline that starts after the onset (a night revived after a reload notes
only what played since) can't say what was playing, so it counts as none.

A night with no timeline (older, or reconciled from a killed tab) still gets
the watch's time, but any attribution it had, which was for a different onset,
is dropped. A self-label ("slept"/"awake") was on the detector's claim,
which the watch replaces, so it is dropped too, and a watch-timed night isn't
offered for labelling.

A watch onset is measured, so the detector's plausibility floor
(`MIN_PLAUSIBLE_ONSET_MS`) doesn't apply to it: three minutes is a real night.
Calibration (`paramsFromHistory`) leaves watch nights out: their touches are
counted over the whole night, not only before the watch's onset (the
detector's onset follows the last touch; the watch's needn't), so after-onset
touches would read as awake ones and make the detector bolder.

## 5. Surfaces

- A paste import that re-timed a night reloads the page on leaving the rest
  view, so the home screen's lines are read again.
- Opening the link imports, clears the fragment at once (a reload or a shared
  link mustn't import again) and shows one line on the home screen: "your
  watch: asleep 12 min in; sleepcast guessed 20 min." A killed tab's night is
  settled into the ledger first, so the morning import can time it, and a
  link landing in an already open tab is caught on `hashchange`. The line
  also says when lines couldn't be read, when nothing was new, and when the
  re-timed nights couldn't be stored.
- The rest view: how many nights the watch timed and the median gap between
  sleepcast's guess and the watch; a link to /watch; the paste box.
- /watch: the Shortcut, step by step, a daily automation at a set morning time
  (not on waking: the watch may not have synced the night yet), and the paste
  variant. The privacy page notes the fragment.
- Times under a minute read "under a minute" everywhere (a watch onset can
  be that fast; the detector's floor never allowed it).

## 6. Out of scope

- Raw heart rate (noisier; sleep stages are Apple's own onset).
- Live, mid-night signals: this is a morning import, not a fused detector.
- Non-English stage names.
- Timelines for nights reconciled from a killed tab (the live snapshot doesn't
  carry one).

## 7. Testing

watch.test.ts: parsing (names, codes, malformed and localised lines), matching
(window, the next night, before start), re-timing (attribution from the
timeline, after the end, no timeline, idempotence, labels), the import against
storage (including a fast onset under the detector's floor), the fragment and
paste readers, the notice and the agreement summary. session.test.ts and
ledger.test.ts cover the recorded timeline, `endedAt` and pruning.
