// What a night needs from a thing that makes sound.
//
// Two implementations: an <audio> element and Google's embedded player. The
// orchestrator talks only to this and never learns which it got — which is the
// whole point, because a mixed night switches between them mid-flight.

/** What the source is actually doing. Four values, not a boolean: "hasn't
 *  started" and "paused" are different, and conflating them is what once
 *  rendered a Pause button over silence. */
export type Transport = "playing" | "paused" | "buffering" | "awaiting-start";

export interface MediaBackend {
  /** An enclosure URL for audio, a videoId for YouTube. The orchestrator picks
   *  the backend from episode.youtubeId and never inspects this again. */
  load(ref: string, startSeconds?: number): void;
  play(): void;
  pause(): void;
  /** 0–1, like HTMLMediaElement.volume. */
  setVolume(level: number): void;
  currentTime(): number;
  duration(): number;
  transport(): Transport;
  destroy(): void;

  /** Fires often enough to drive a 60-second fade. Each implementation owns
   *  its own clock: an <audio> has timeupdate, which keeps firing through a
   *  locked screen; an iframe has nothing and must poll. Returns an
   *  unsubscribe, because the orchestrator swaps backends per episode and a
   *  handler that outlives its backend fires against a dead one. */
  onProgress(cb: () => void): () => void;
  onEnded(cb: () => void): () => void;
  onError(cb: (code: number | string) => void): () => void;
}
