// Google Analytics, only with consent.
//
// Nothing of Google's loads until the visitor accepts the banner: not the
// script, not a cookieless ping. That is what the privacy page promises
// ("analytics is off until you accept"). Consent Mode's "advanced" setup,
// which loads gtag.js at once with storage denied, would still send pings
// for visitors who declined.
//
// Run from PlayerLayout as a script Astro processes: Astro's CSP hashes only
// those, and blocked the is:inline versions this replaces, so analytics and
// the banner never ran. gtag.js's host is allowed in astro.config.mjs.

export const GA_ID = "G-DPQWL1XFMD";
export const CONSENT_KEY = "sc-consent";
const GTAG_SRC = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;

type Consent = "granted" | "denied";

export function storedConsent(): Consent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  } catch {
    return null;
  }
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** Load gtag.js and start measuring. Once per page. */
export function startAnalytics(doc: Document = document): void {
  if (window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  // gtag.js reads `arguments` objects off the dataLayer, not arrays.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
  window.gtag("js", new Date());
  window.gtag("config", GA_ID);
  const s = doc.createElement("script");
  s.async = true;
  s.src = GTAG_SRC;
  doc.head.appendChild(s);
}

/** The banner on a first visit, analytics after an accept, and the privacy
 *  page's "change your choice". */
export function initConsent(doc: Document = document): void {
  const consent = storedConsent();
  if (consent === "granted") startAnalytics(doc);

  const banner = doc.getElementById("sc-consent");
  if (banner && consent === null) {
    banner.hidden = false;
    const choose = (v: Consent) => {
      try { localStorage.setItem(CONSENT_KEY, v); } catch { /* the choice holds for this page */ }
      banner.hidden = true;
      if (v === "granted") startAnalytics(doc);
    };
    doc.getElementById("sc-accept")?.addEventListener("click", () => choose("granted"));
    doc.getElementById("sc-decline")?.addEventListener("click", () => choose("denied"));
  }

  // Withdrawing is as easy as giving: forget the choice and ask again. A
  // reload, so a gtag.js already running stops.
  const status = doc.getElementById("sc-consent-status");
  if (status) status.textContent = consent === "granted" ? "you accepted analytics." : consent === "denied" ? "you declined analytics." : "you haven't chosen yet.";
  doc.getElementById("sc-consent-reset")?.addEventListener("click", () => {
    try { localStorage.removeItem(CONSENT_KEY); } catch { /* ignore */ }
    // First, or gtag.js writes its session cookie back as the page unloads.
    window.gtag?.("consent", "update", { analytics_storage: "denied" });
    clearGaCookies(doc);
    location.reload();
  });
}

/** Google Analytics' own cookies (_ga, _ga_<id>), set on the site's domain. */
export function clearGaCookies(doc: Document = document): void {
  const host = doc.location?.hostname ?? "";
  for (const part of doc.cookie.split(";")) {
    const name = part.split("=")[0].trim();
    if (!name.startsWith("_ga")) continue;
    for (const domain of ["", `; domain=${host}`, `; domain=.${host}`]) {
      doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
    }
  }
}
