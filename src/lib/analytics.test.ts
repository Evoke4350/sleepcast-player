import { describe, it, expect, beforeEach } from "vitest";
import { initConsent, startAnalytics, clearGaCookies, CONSENT_KEY } from "./analytics";

const gtagScripts = () => document.querySelectorAll('script[src^="https://www.googletagmanager.com/gtag/js"]').length;

beforeEach(() => {
  localStorage.clear();
  delete window.gtag;
  delete window.dataLayer;
  document.head.innerHTML = "";
  document.body.innerHTML = `
    <div id="sc-consent" hidden><button id="sc-decline"></button><button id="sc-accept"></button></div>
    <span id="sc-consent-status"></span>`;
});

describe("analytics consent", () => {
  it("first visit: asks, and loads nothing of Google's", () => {
    initConsent();
    expect(document.getElementById("sc-consent")!.hidden).toBe(false);
    expect(gtagScripts()).toBe(0);
    expect(window.dataLayer).toBeUndefined();
    expect(document.getElementById("sc-consent-status")!.textContent).toBe("you haven't chosen yet.");
  });

  it("accept: remembered, and gtag.js loads with analytics storage granted, ads denied", () => {
    initConsent();
    document.getElementById("sc-accept")!.click();
    expect(localStorage.getItem(CONSENT_KEY)).toBe("granted");
    expect(document.getElementById("sc-consent")!.hidden).toBe(true);
    expect(gtagScripts()).toBe(1);
    const consent = Array.from(window.dataLayer![0] as IArguments);
    expect(consent).toEqual(["consent", "default", expect.objectContaining({ analytics_storage: "granted", ad_storage: "denied" })]);
    // gtag.js needs arguments objects, not arrays.
    expect(Array.isArray(window.dataLayer![0])).toBe(false);
  });

  it("decline: remembered, and nothing loads, then or on later visits", () => {
    initConsent();
    document.getElementById("sc-decline")!.click();
    expect(localStorage.getItem(CONSENT_KEY)).toBe("denied");
    initConsent();
    expect(gtagScripts()).toBe(0);
    expect(document.getElementById("sc-consent-status")!.textContent).toBe("you declined analytics.");
  });

  it("a later visit after accepting: loads at once, no banner", () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    initConsent();
    expect(gtagScripts()).toBe(1);
    expect(document.getElementById("sc-consent")!.hidden).toBe(true);
  });

  it("loads once per page", () => {
    startAnalytics();
    startAnalytics();
    expect(gtagScripts()).toBe(1);
  });

  it("changing your mind clears Google's cookies", () => {
    document.cookie = "_ga=GA1.1.1; path=/";
    document.cookie = "_ga_DPQWL1XFMD=GS1; path=/";
    document.cookie = "other=1; path=/";
    clearGaCookies();
    expect(document.cookie).toBe("other=1");
  });
});
