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
server, and sleepcast sends the samples nowhere: they go from Health to the
browser's storage. (Safari may keep the opened link in its history, which the
privacy page and /watch say.) No account, no endpoint, no native build.

Payload: a first line `window~<start>` (where the Shortcut's window opens: it
reads samples ending after "now minus 2 days", so a sample under way when
the window opens is there from its own start; a window line with no
samples yet (the watch hadn't synced) still goes ahead, recording a killed
tab's night, and says to run it again later; a window line that opens in
the future (an adjust-date step left adding) is a bad one; without the line
the import is
refused, with a notice pointing at the updated steps), then one sample per
line, `start~end~stage`, ISO 8601 dates with time, the
stage as Health names it (Core, Deep, REM, Asleep, Awake, In Bed, matched as
whole names) or its numeric code (HKCategoryValueSleepAnalysis 0–5). English
names only, and any unrecognised name refuses the whole import: in several
languages REM is still "REM" while the other stages aren't English, and the
recognised part alone would time the night from its first REM stage. A line
whose dates lack a time or don't parse (or whose end comes first), that
hasn't three fields, or whose stage isn't a name or code is malformed, and any
malformed line refuses the import too: a sample missing from inside a stretch
would split it, and its next stage change would pass for falling asleep. The
notice names the Shortcut's format as the likely cause. The newest 2000 lines
are read.

A home-screen copy of the site keeps its own storage, apart from Safari's, so
the link can't reach it. For that, the Shortcut copies the lines instead, and
the rest view has a "paste from your watch" box (it accepts the lines or the
whole link, itself perhaps percent-encoded). From a pasted link it takes, if
url-encoded whole, the link itself (up to the first space, less trailing
punctuation, unless the next word goes on with the payload: a wrapped link),
and otherwise (the encode step missed, or done in part) the rest of the
paste, decoded as the link would be. It
reads with the payload's own grammar only: anything else that came with it (a
message's words, a quote marker, line breaks turned to spaces) refuses the
import, which changes nothing, rather than being guessed away.

## 3. Matching

Asleep samples (Core, Deep, REM, Asleep) are merged into stretches of sleep
where one begins within a minute of the last's end. A night's watch onset is
the start of the first stretch that begins at or after the night's start,
within `MATCH_WINDOW_MS` (4 h), before the next night's start (a 3am
re-anchor is its own night), and before `AFTER_END_MS` (30 min) past the
night's end (drifting off in the quiet after the fade; later sleep began
without sleepcast, and a night stopped after three minutes isn't timed by it). A stretch that began before the night's start
doesn't count, nor does a stage change within it: the listener was awake to
press start. A night whose start falls inside a stretch has no onset at all:
the watch had the listener asleep as they pressed start, so it can't say when
they fell asleep, and a stretch after a later wake, hours in, would pass for
it. The night keeps what it has (the detector's guess, a label, or a time the
watch gave it before: a timed night stays timed): the watch can be wrong there
too, scoring lying still or reading as sleep, and the night's own touches may
say otherwise. The notice names it when it is the newest night (or the killed
tab's night the import records), unless the watch had timed it: the next
morning's run reads it again, and would say it again. Only nights that began more than a minute (CONTIGUOUS_MS) after
the window opened are matched (`timeableFrom`, which the notice's "run it again later" uses
too, so the notice never asks for a run that can't time a night): for
an earlier one the window may have cut its sleep off (whether it began before
the night's start is unknown, and a stage change after a brief wake would pass
for its onset), so it keeps what it has. A later night has
every sample under way at or after its start (the Shortcut filters by end
date, so samples that began before the window and run into it are there
too, which is what the began-before-start guard needs), so its first-ever
night is timed too.

## 4. Re-timing

A matched night becomes `detector: "watch"`, `sleptAtMs`/`timeToSleepMs` the
watch's onset, and keeps the detector's onset as `inferredAtMs` (null when it
found none, or the listener said it was wrong: labelled "awake"). Re-importing is idempotent: `inferredAtMs` keeps the detector's
original. A night the watch already timed at the same onset is left alone
and counted as unchanged, not re-timed (the Shortcut reads two days, so each
morning re-reads the night before).

Attribution (onset feed and episode, `onsetAfterMs`, `sleptThrough`) is redone
from the night's `timeline` with the same function `RestSession.finish` uses
(`attribution`, rest/attribution.ts). To make that possible, nights now record:

- `timeline`: the night's episode starts, kept `TIMELINE_KEEP_MS` (3 days: the Shortcut reads two) and
  pruned on every ledger write (`storeNights`), so 90 nights of episode ids don't crowd
  storage;
- `endedAt`: an onset after the night ended credits no show (the audio had
  stopped). A night reconciled from a killed tab ends when it was last seen
  alive, not at its scheduled fade: nothing after was observed.

A timeline that starts after the onset (a night revived after a reload notes
only what played since) can't say what was playing, so it counts as none.

The same night can be recorded twice: a watch import records a killed tab's
snapshot, and can't tell a suspended tab's from it; the tab may wake and
record its night again (by ending it, or by being reconciled). One merge rule,
`merge` (applied by `withNight`, which `appendNight` and the import's killed
night use, and by `loadNights` to any older copies), replaces a night with the
same start, keeping the watch's time (re-attributed from the real night's timeline) if it had one. The
ledger reads any older copies of a night as one (`collapsed`, in
`loadNights`), so every reader agrees; of two watch-timed copies, the later
recorded wins. A
night older than every one the 90-night cap keeps is recorded like any other
(and its snapshot cleared), and not kept: the ledger holds the newest.

A night with no timeline (older, or reconciled from a killed tab) still gets
the watch's time, but any attribution it had, which was for a different onset,
is dropped. A self-label ("slept"/"awake") was on the detector's claim,
which the watch replaces, so it is dropped too, and a watch-timed night isn't
offered for labelling: `setSelfLabel` itself refuses one, so a screen in another
tab still showing the offer from before the import can't label it.

A watch onset is measured, so the detector's plausibility floor
(`MIN_PLAUSIBLE_ONSET_MS`) doesn't apply to it: three minutes is a real night.
Calibration (`paramsFromHistory`) counts a watch night by the detector's own
onset (`inferredAtMs`), as it did before the watch re-timed it: its touches are
counted over the whole night, and the detector's onset follows the last touch
while the watch's needn't, so the watch's onset would read after-onset touches
as awake ones and make the detector bolder. A watch night with no detector
onset isn't counted, so the detector keeps learning as the watch takes over.

## 5. Surfaces

- A paste import that re-timed a night, or recorded a killed tab's night
  first, reloads the page on leaving the rest view, so the home screen's
  lines (and the resume offer) are read again.
- A head script (PlayerLayout, hash-allowed in the CSP) moves the fragment
  out of the address before analytics can read the page's URL, on load and
  if a link lands later; the island reads it from there. So nothing on the
  page reads the sleep stages from the address, and a reload or a shared
  link can't import them again.
- Opening the link imports and shows one line on the home screen: "your
  watch: asleep 12 min in; sleepcast guessed 20 min." A killed tab's night is
  recorded into the ledger first, so the morning import can time it: a watch
  import means the night is over, so even a snapshot that could still be
  revived (a timerless night's) is recorded, unless it was saved in the last
  30 s (it may be playing in another tab). Its last-night record says
  "ended", not "faded", so no 3am re-anchor offers to continue it. The line also says when lines
  couldn't be read, when nothing was new, and when the re-timed nights
  couldn't be stored. Each night stored without the watch's time is named
  with its one reason (a killed tab's night to run again for, or that no run
  can time; a night the watch had the listener asleep at the start of),
  whatever else the line says.
- A link landing in a tab already open (only the fragment changes) is held
  and offered on the home screen ("your watch's night came in: read it"),
  read by a reload when tapped: never a reload by itself, which could end a
  night still on or lose what was being typed. The held link is handed
  across that reload through session storage (read and cleared by the head
  script), never back through the address. A paste reloads without it: the held
  link is older, and imported after the paste would undo its times. If session
  storage is blocked, so the link can't be handed on, the offer is replaced
  with a line saying to close the tab and run the Shortcut again (a new tab
  reads the link on load). The
  line and the offer also show above a 3am re-anchor.
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
- Pauses. A timeline records episode starts, not pauses, so a watch onset
  while the audio sat paused (the getting-up rule's pause, a lock-screen
  pause) credits the paused episode. Recording pauses would mean every
  player noting them; the case is rare, and the credit goes to the show the
  listener was drifting to.
- A night's `endedAt` is when its session finished. A timed night whose tab
  was suspended past its timer and finished on waking records the waking
  time, so a watch onset after the timer's scheduled end still credits the
  last episode. The session doesn't know the timer's extensions, so its
  scheduled end can't be told; reconciled nights (killed tabs) use last seen
  alive instead.
- Two tabs playing the same night at once (a resume card tapped in one
  while another plays it): a multi-tab race, as elsewhere in the app. A
  resume tap revives only a still-revivable snapshot of the card's night
  (`resumeTarget`); a stale card is replaced by what storage holds now.
- A link held in an open tab (see §5) lives in memory until it is read; if
  the page goes first (the tab killed, a link followed) it is lost, and the
  next morning's run (two days) makes it up.

## 7. Testing

watch.test.ts: parsing (names, codes, malformed and localised lines), matching
(window, the next night, before start), re-timing (attribution from the
timeline, after the end, no timeline, idempotence, labels), the import against
storage (including a fast onset under the detector's floor), the fragment and
paste readers, the notice, the agreement summary and the same night recorded
twice. session.test.ts and ledger.test.ts cover the recorded timeline,
`endedAt` and pruning; reconcile.test.ts the killed night recorded first, a
snapshot kept when storage is full, and a woken tab's night recorded again;
watch-link-script.test.ts the head script (the fragment taken out of the
address, the held link handed across a reload, the redirect from other
pages), run against a stand-in location and history.
