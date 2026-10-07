import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TAKE_WATCH_LINK } from "./watch-link-script";
import { WATCH_PENDING_KEY } from "./rest/watch-hash";

/** A stand-in for the page's location and history: the script reads and
 *  writes these by their global names, so it is run with them in scope. */
function page(url: string) {
  const u = new URL(url, "https://sleepcast.pro");
  const loc = {
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
    replaced: null as string | null,
    replace(to: string) {
      this.replaced = to;
    },
  };
  const hist = {
    replaceState(_s: unknown, _t: string, to: string) {
      const v = new URL(to, "https://sleepcast.pro");
      loc.pathname = v.pathname;
      loc.search = v.search;
      loc.hash = v.hash;
    },
  };
  return { loc, hist };
}

/** Runs the script on a page, keeping the listeners it adds so each test
 *  removes them (they would pile up across tests otherwise). */
const added: [string, EventListenerOrEventListenerObject][] = [];
function run(p: ReturnType<typeof page>) {
  const add = window.addEventListener;
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject) => {
    added.push([type, fn]);
    add.call(window, type, fn);
  }) as typeof window.addEventListener;
  try {
    new Function("location", "history", TAKE_WATCH_LINK)(p.loc, p.hist);
  } finally {
    window.addEventListener = add;
  }
}

describe("the head script that moves a watch link out of the address", () => {
  beforeEach(() => {
    window.__sleepcastWatch = null;
    sessionStorage.clear();
  });
  afterEach(() => {
    for (const [type, fn] of added.splice(0)) window.removeEventListener(type, fn);
  });

  it("takes a #watch= fragment out of the address and holds it", () => {
    const p = page("/?x=1#watch=a~b~Core");
    run(p);
    expect(window.__sleepcastWatch).toBe("#watch=a~b~Core");
    expect(p.loc.hash).toBe("");
    expect(p.loc.search).toBe("?x=1");
  });

  it("leaves any other fragment alone", () => {
    const p = page("/#other");
    run(p);
    expect(window.__sleepcastWatch).toBeNull();
    expect(p.loc.hash).toBe("#other");
  });

  it("tells the island when it holds one", () => {
    let told = 0;
    const on = () => told++;
    window.addEventListener("sleepcast-watch", on);
    run(page("/#watch=x"));
    window.removeEventListener("sleepcast-watch", on);
    expect(told).toBe(1);
  });

  it("reads, once, a held link handed across a reload", () => {
    sessionStorage.setItem(WATCH_PENDING_KEY, "#watch=held");
    run(page("/"));
    expect(window.__sleepcastWatch).toBe("#watch=held");
    expect(sessionStorage.getItem(WATCH_PENDING_KEY)).toBeNull();
  });

  it("ignores a handed-on value that isn't a watch link", () => {
    sessionStorage.setItem(WATCH_PENDING_KEY, "#nope");
    run(page("/"));
    expect(window.__sleepcastWatch).toBeNull();
  });

  it("off the home page, clears the address, then sends the link on to /", () => {
    const p = page("/watch#watch=x");
    run(p);
    expect(p.loc.hash).toBe("");
    expect(p.loc.replaced).toBe("/#watch=x");
    expect(window.__sleepcastWatch).toBeNull();
  });
});
