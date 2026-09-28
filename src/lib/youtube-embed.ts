// Building the embedded YouTube player, in one place.
//
// Night and YouTubeNight each carried a copy of this: the same host, sizing,
// playerVars and event wiring, differing only in whether to autoplay and
// whether to start the video once ready. Every change to the embed had to be
// made twice. The events go straight to YouTubeMedia (CreatePlayerArgs), which
// filters them through its switch guard before the caller sees them.
import type { CreatePlayerArgs, YTPlayerLike } from "./youtube-media";
import type { YTNamespace } from "./youtube-api";

/** The embed origin. youtube-nocookie.com is Google's own reduced-tracking
 *  host: it still loads Google's player and Google still sees the request, but
 *  it does not set the advertising cookies the default domain does. The
 *  privacy policy states this rather than implying it away. */
export const YT_EMBED_HOST = "https://www.youtube-nocookie.com";

export interface EmbedOptions {
  autoplay: boolean;
  /** Asked at onReady: start the video now? (Night: only if it is still the
   *  live backend, since a Next during loading leaves a podcast playing.) */
  shouldStartOnReady: () => boolean;
}

// YT.Player REPLACES the element it is handed with an iframe. So it is given a
// plain div created here rather than one React rendered — React never knows
// about the node, and cannot trip over a child that vanished from under it.
export function buildYouTubePlayer(
  YT: YTNamespace,
  host: HTMLElement,
  args: CreatePlayerArgs,
  opts: EmbedOptions,
): YTPlayerLike {
  const mount = document.createElement("div");
  host.appendChild(mount);
  const player = new YT.Player(mount, {
    host: YT_EMBED_HOST,
    videoId: args.videoId,
    width: "100%",
    height: "100%",
    playerVars: {
      autoplay: opts.autoplay ? 1 : 0,
      playsinline: 1,
      // No chrome to catch a sleepy thumb, no related-video grid at the end,
      // no keyboard, no annotations. The app's transport is the transport.
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      iv_load_policy: 3,
      modestbranding: 1,
      start: Math.floor(args.startSeconds ?? 0),
      origin: typeof location === "undefined" ? undefined : location.origin,
    },
    events: {
      onReady: (e: { target: YTPlayerLike }) => {
        // Not if the wrapper is already dead (the night ended while the
        // iframe loaded): it refuses to drive the player then, and so must this.
        const live = args.onReady();
        // Starting a night IS a user gesture, but Google's script has to load
        // first and that gap routinely outlives the gesture's grace on a phone.
        // Ask anyway — when the answer is no, the video sits at "unstarted" and
        // the tap prompt takes over. It is not an error.
        if (live && opts.shouldStartOnReady()) e.target.playVideo();
      },
      onStateChange: (e: { data: number }) => args.onStateChange(e.data),
      onError: (e: { data: number }) => args.onError(e.data),
    },
  });
  return player as unknown as YTPlayerLike;
}
