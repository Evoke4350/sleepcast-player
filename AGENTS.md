# sleepcast-player

**Astro 6, not Next.js.** Static pages (`output: "static"`), React only as
islands, served from Cloudflare Workers Static Assets; the one server route,
`/api/relay`, is the Worker in `worker/` (`wrangler.jsonc`). Node 22 required,
managed by mise: `mise exec node@22 -- npm run build`. `npm run preview` runs
the Worker locally; `npm run deploy` builds and deploys.

Read `README.md` first — it explains why the player refuses features that a
normal podcast app would have.

## Things that will bite you

- **`/api/relay` fetches on behalf of anyone who asks.** It exists because
  browsers cannot fetch podcast feeds cross-origin. Keep the URL check, the
  per-IP rate limit (the `RELAY_LIMIT` binding), the feed sniff and the size
  cap. It is not a general proxy. It relies on Workers being unable to reach
  private networks; moved to a host that can, it needs DNS pinning back.
- **Tailwind's Vite plugin is pinned to Astro's Vite** (`overrides` in
  package.json). Vitest brings Vite 8; the plugin picking that up breaks the
  static build with "Missing field `tsconfigPaths`".
- **The player survives a full reload** via `store.saveLive`/`loadLive`, a
  localStorage snapshot of the night. Don't assume it is stateless across
  reloads.
- **No accounts, no database.** Google Analytics is the only third-party
  analytics, and nothing of Google's loads until the visitor accepts the
  consent banner (`src/lib/analytics.ts`). Scripts in layouts must not be
  `is:inline`: Astro's CSP hashes only the scripts it processes, so an inline
  one is silently blocked. Feed
  data, settings, and history stay in `localStorage`.
- **The sleep detector must stay conservative.** A false positive ends someone's
  night early. When changing `src/lib/rest/detector.ts`, run
  `detector.sim.test.ts` — it runs synthetic nights and is the only thing that
  catches a threshold change that looks fine in unit tests.

## Upstream

This is the canonical home of the player. sleepcast.pro consumes it as a
submodule; changes here flow there, not the other way around.

## Imports are relative on purpose

There is no `@/` alias. The player is mounted inside sleepcast.pro as a
submodule, where `@/` resolves against the HOST app's `src/` — so an aliased
import here would silently bind to the wrong file over there. Use relative
paths. If you add an alias, you break the consumer and the break is invisible
until runtime.
