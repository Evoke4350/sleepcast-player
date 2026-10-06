import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TAKE_WATCH_LINK } from "./watch-link-script";
import { WATCH_PENDING_KEY } from "./rest/watch-hash";

/** Runs the script, keeping the listeners it adds so each test removes
 *  them (they would pile up across tests otherwise). */
const added: [string, EventListenerOrEventListenerObject][] = [];
const run = () => {
  const add = window.addEventListener;
  window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject) => {
    added.push([type, fn]);
    add.call(window, type, fn);
  }) as typeof window.addEventListener;
  try {
    new Function(TAKE_WATCH_LINK)();
  } finally {
    window.addEventListener = add;
  }
};
afterEach(() => {
  for (const [type, fn] of added.splice(0)) window.removeEventListener(type, fn);
});

describe("the head script that moves a watch link out of the address", () => {
  beforeEach(() => {
    window.__sleepcastWatch = null;
    sessionStorage.clear();
    history.replaceState(null, "", "/");
  });

  it("takes a #watch= fragment out of the address and holds it", () => {
    history.replaceState(null, "", "/?x=1#watch=a~b~Core");
    run();
    expect(window.__sleepcastWatch).toBe("#watch=a~b~Core");
    expect(location.hash).toBe("");
    expect(location.search).toBe("?x=1");
  });

  it("leaves any other fragment alone", () => {
    history.replaceState(null, "", "/#other");
    run();
    expect(window.__sleepcastWatch).toBeNull();
    expect(location.hash).toBe("#other");
  });

  it("tells the island when it holds one", () => {
    history.replaceState(null, "", "/#watch=x");
    let told = 0;
    const on = () => told++;
    window.addEventListener("sleepcast-watch", on);
    run();
    window.removeEventListener("sleepcast-watch", on);
    expect(told).toBe(1);
  });

  it("reads, once, a held link handed across a reload", () => {
    sessionStorage.setItem(WATCH_PENDING_KEY, "#watch=held");
    run();
    expect(window.__sleepcastWatch).toBe("#watch=held");
    expect(sessionStorage.getItem(WATCH_PENDING_KEY)).toBeNull();
  });

  it("ignores a handed-on value that isn't a watch link", () => {
    sessionStorage.setItem(WATCH_PENDING_KEY, "#nope");
    run();
    expect(window.__sleepcastWatch).toBeNull();
  });

  it("off the home page, clears the address before sending the link on", () => {
    history.replaceState(null, "", "/watch#watch=x");
    // jsdom can't navigate; the address is clean before it tries.
    try {
      run();
    } catch {
      /* not implemented: navigation */
    }
    expect(location.hash).toBe("");
    expect(window.__sleepcastWatch).toBeNull();
  });
});
