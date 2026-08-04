import { describe, expect, test } from "vitest";
import { youtubeHandleUrl, channelIdFromHtml } from "./youtube-resolve";

describe("turning a handle into a page we are willing to fetch", () => {
  test("builds the channel URL", () => {
    expect(youtubeHandleUrl("bub.explains")).toBe("https://www.youtube.com/@bub.explains");
  });

  test("a leading @ is the same handle", () => {
    expect(youtubeHandleUrl("@bub.explains")).toBe("https://www.youtube.com/@bub.explains");
  });

  test("dots, underscores and hyphens are ordinary in handles", () => {
    expect(youtubeHandleUrl("a_b-c.d")).toBe("https://www.youtube.com/@a_b-c.d");
  });

  test("anything that could steer the fetch elsewhere is refused", () => {
    // This value comes off the wire and becomes a URL the server fetches. A
    // slash, a dot-dot, a scheme or a host in it would make this endpoint a
    // way to reach something other than a YouTube channel page — which is the
    // whole thing /api/relay's guard exists to prevent, and this must not be
    // a second, softer door to it.
    for (const bad of [
      "a/b",
      "../etc",
      "a?x=1",
      "a#b",
      "a b",
      "evil.com/@x",
      "https://evil.com",
      "a%2Fb",
      "a\\b",
      "a@b",
      "",
      "@",
    ]) {
      expect(youtubeHandleUrl(bad)).toBeNull();
    }
  });

  test("an absurdly long handle is refused rather than sent", () => {
    expect(youtubeHandleUrl("a".repeat(200))).toBeNull();
  });
});

describe("finding the channel id in what YouTube served", () => {
  test("prefers the canonical link, which is what the page declares itself to be", () => {
    const html = `<link rel="canonical" href="https://www.youtube.com/channel/UCuDUP15RMVaHsZ-ln9SyYqg">`;
    expect(channelIdFromHtml(html)).toBe("UCuDUP15RMVaHsZ-ln9SyYqg");
  });

  test("falls back to og:url", () => {
    const html = `<meta property="og:url" content="https://www.youtube.com/channel/UCuDUP15RMVaHsZ-ln9SyYqg">`;
    expect(channelIdFromHtml(html)).toBe("UCuDUP15RMVaHsZ-ln9SyYqg");
  });

  test("falls back to the externalId the page carries in its own data", () => {
    expect(channelIdFromHtml(`{"externalId":"UCuDUP15RMVaHsZ-ln9SyYqg"}`)).toBe(
      "UCuDUP15RMVaHsZ-ln9SyYqg",
    );
  });

  test("and to browseId, which appears dozens of times on a channel page", () => {
    expect(channelIdFromHtml(`{"browseId":"UCuDUP15RMVaHsZ-ln9SyYqg"}`)).toBe(
      "UCuDUP15RMVaHsZ-ln9SyYqg",
    );
  });

  test("a canonical pointing at a video is not a channel id", () => {
    // Handles can be typed wrong and YouTube will happily serve something
    // else. Taking any UC-shaped string off any page would subscribe the
    // listener to a channel they did not ask for.
    const html = `<link rel="canonical" href="https://www.youtube.com/watch?v=Km4dGTJYiwQ">`;
    expect(channelIdFromHtml(html)).toBeNull();
  });

  test("a page with nothing in it yields nothing", () => {
    expect(channelIdFromHtml("<html><body>not found</body></html>")).toBeNull();
    expect(channelIdFromHtml("")).toBeNull();
  });

  test("an id of the wrong shape is not accepted", () => {
    // UC + exactly 22 characters. Anything else is not a channel id, whatever
    // it is sitting next to.
    expect(channelIdFromHtml(`{"externalId":"UCtooshort"}`)).toBeNull();
  });
});
