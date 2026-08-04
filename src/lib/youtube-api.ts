// Getting Google's IFrame Player API onto the page.
//
// The API is a script that, when it finishes, sets window.YT and then calls a
// single global hook — window.onYouTubeIframeAPIReady. Both of those are
// process-wide, which makes this awkward in three specific ways, and all three
// are why this is a module with tests rather than four lines in a component:
//
//   - The hook is ONE slot. Overwrite it and whoever set it first never fires;
//     get overwritten and we never fire. So an existing handler is chained.
//   - window.YT appears BEFORE YT.Player is defined, so the presence of the
//     object is not readiness. Constructing from the bare object yields a
//     player that never plays.
//   - It can simply never arrive — a blocked host, an offline phone, a CSP
//     that forbids the origin. With no deadline the promise never settles and
//     the component sits rendering nothing at all. Silence until morning is
//     this app's worst failure, so a load has a deadline and a rejection.

export const YT_API_SRC = "https://www.youtube.com/iframe_api";

/** How long to wait for Google's script before giving up on the night. */
export const YT_API_TIMEOUT_MS = 15_000;

/** The slice of the YT namespace this app constructs against. */
export interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => unknown;
}

export interface ApiWindow {
  YT?: unknown;
  onYouTubeIframeAPIReady?: () => void;
}

function readyNamespace(win: ApiWindow): YTNamespace | undefined {
  const yt = win.YT as YTNamespace | undefined;
  return yt && typeof yt.Player === "function" ? yt : undefined;
}

/**
 * A loader bound to one window and one way of injecting a script. Its
 * in-flight promise is closure state rather than module state, so tests get a
 * fresh one per case and cannot leak a resolved API between them.
 */
export function createApiLoader(
  win: ApiWindow,
  inject: (src: string) => void,
): (timeoutMs?: number) => Promise<YTNamespace> {
  let pending: Promise<YTNamespace> | null = null;

  return function load(timeoutMs = YT_API_TIMEOUT_MS): Promise<YTNamespace> {
    const already = readyNamespace(win);
    if (already) return Promise.resolve(already);
    if (pending) return pending;

    const previous = win.onYouTubeIframeAPIReady;
    pending = new Promise<YTNamespace>((resolve, reject) => {
      const fail = (message: string) => {
        // Clearing `pending` is what makes a failure retryable. Cached, one
        // flaky night would disable the feature until a full page reload.
        pending = null;
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail("the YouTube player script did not load"),
        timeoutMs,
      );
      win.onYouTubeIframeAPIReady = () => {
        previous?.();
        clearTimeout(timer);
        const ns = readyNamespace(win);
        if (ns) resolve(ns);
        else fail("the YouTube player script loaded but defined no player");
      };
    });
    // After the hook is installed, never before: a cached script can run the
    // moment it is appended.
    inject(YT_API_SRC);
    return pending;
  };
}

function injectScript(src: string): void {
  const el = document.createElement("script");
  el.src = src;
  el.async = true;
  document.head.appendChild(el);
}

/** The app's loader. One per page, because the API itself is one per page. */
export const loadYouTubeApi =
  typeof window === "undefined"
    ? () => Promise.reject(new Error("no window"))
    : createApiLoader(window as unknown as ApiWindow, injectScript);
