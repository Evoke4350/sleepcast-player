# Ideas for later

Tabled on 2026-10-27, after "what wakes you" was built.

## Experiment mode
Pick two options, such as two shows or two timer lengths. Sleepcast picks one at random each night, and after about 10 nights it reports which put you to sleep faster, with a check on whether the difference could be chance. The by-show table in the Rest tab is only a rough guide, because shows get different nights; randomising fixes that. Proven results could then drive "Favor what puts me under".

## Fit the detector to the watch
Every night the watch saw is a labelled example: its onset (`watchSleptAfterMs`) against Sleepcast's guess (`appSleptAtMs`). Fit `DetectorParams` to them, so that nights without the watch get a believable onset.

## Morning rating
A one-tap "How rested do you feel?" from 1 to 5, the morning after. The watch measures sleep, not how it felt; pairing the two would show which nights felt good.

## Sync between Safari and the Home Screen app
They keep separate storage, which is why the watch Shortcut needs the clipboard step. The only fix is syncing through a server (Cloudflare's free tier would do), but nights would then leave the phone for the first time. That's a privacy decision to make first.
