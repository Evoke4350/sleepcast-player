// What to do when a YouTube video refuses to play.
//
// An <audio> element fails in ways this app already understands: a dead
// enclosure URL, a host serving no CORS headers, a stalled load. The embedded
// player fails differently, and one of its failures is common enough to matter
// on exactly the content this feature targets — a great many long ambient and
// narration uploads have embedding switched off, so they play fine on
// youtube.com and not at all anywhere else.
//
// The governing rule is that a night must keep moving. Sitting in silence
// while the countdown runs down is the worst failure this app has: the timer
// completes, the fade runs, the session ends normally, and the listener simply
// got nothing. Skipping an episode is recoverable; stalling on one is not.
// So an unrecognised failure skips rather than retries.
//
// Codes are YouTube's, from the IFrame API's onError.

export interface YouTubeErrorVerdict {
  /** "skip" moves to the next episode; "retry" gives this one another go. */
  action: "skip" | "retry";
  /** True when the video can never play here, so it is worth remembering
   *  across nights rather than rediscovering every time. */
  permanent: boolean;
  reason: string;
}

export function classifyYouTubeError(code: number): YouTubeErrorVerdict {
  switch (code) {
    // 101 and 150 are the same condition reported two ways.
    case 101:
    case 150:
      return {
        action: "skip",
        permanent: true,
        reason: "the uploader does not allow this video to be played outside YouTube",
      };
    case 100:
      return {
        action: "skip",
        permanent: true,
        reason: "the video is private or has been removed",
      };
    case 2:
      return {
        action: "skip",
        permanent: true,
        reason: "the video id is not one YouTube recognises",
      };
    // The player itself erring, not a verdict on the video.
    case 5:
      return {
        action: "retry",
        permanent: false,
        reason: "the YouTube player failed to start",
      };
    default:
      return {
        action: "skip",
        // Skipped for tonight, eligible again tomorrow: we do not know the
        // video is broken, only that it did not start this time.
        permanent: false,
        reason: `the YouTube player reported an error we do not recognise (${code})`,
      };
  }
}
