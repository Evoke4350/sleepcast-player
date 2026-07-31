# sleepcast-player

**Astro 6, not Next.js.** SSR via the Node standalone adapter, React only as
islands. Node 22 required, managed by mise: `mise exec node@22 -- npm run build`.

Read `README.md` first — it explains why the player refuses features that a
normal podcast app would have.

## Things that will bite you

- **`/api/relay` fetches on behalf of anyone who asks.** It exists because
  browsers cannot fetch podcast feeds cross-origin. Keep the SSRF guard, the
  address pinning, the per-IP rate limit and the feed sniff. It is not a
  general proxy, and without those checks it reaches your metadata endpoint.
- **Rate limits are per-machine and in-memory.** Two instances behind a load
  balancer means double the effective limit. It bounds abuse; it is not a quota.
- **The player survives a full reload** via `store.saveLive`/`loadLive`, a
  localStorage snapshot of the night. Don't assume it is stateless across
  reloads.
- **No analytics, no cookies, no accounts, no database.** Nothing here should
  ever add a dependency implying otherwise.
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
