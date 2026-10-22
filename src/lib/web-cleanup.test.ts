import { describe, it, expect, beforeEach } from "vitest";
import { cleanStoredWebData, isYouTubeUrl } from "./web-cleanup";

const ep = (id: string, video = false) => ({ id, title: id, url: `https://x/${id}.mp3`, feedId: "f", date: "", ...(video ? { youtubeId: id } : {}) });

describe("cleanStoredWebData", () => {
  beforeEach(() => localStorage.clear());
  it("drops YouTube feeds and skip-intro minutes from the feed list", () => {
    localStorage.setItem("sleepcast2.state", JSON.stringify({
      feeds: [
        { id: "a", url: "https://pod.example/rss", skipIntroMin: 5 },
        { id: "b", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UC1", skipIntroMin: 0 },
      ],
      settings: {},
    }));
    cleanStoredWebData();
    const state = JSON.parse(localStorage.getItem("sleepcast2.state")!);
    expect(state.feeds).toEqual([{ id: "a", url: "https://pod.example/rss", skipIntroMin: 0 }]);
  });
  it("takes the videos and skip map out of the stored nights, and drops one with nothing playable", () => {
    localStorage.setItem("sleepcast2.lastnight", JSON.stringify({ pool: [ep("p"), ep("v", true)], skipIntroByFeedId: { f: 5 } }));
    localStorage.setItem("sleepcast2.live", JSON.stringify({ current: ep("v", true), pool: [ep("v", true)] }));
    localStorage.setItem("sleepcast2.lastep", JSON.stringify(ep("v", true)));
    cleanStoredWebData();
    expect(JSON.parse(localStorage.getItem("sleepcast2.lastnight")!)).toMatchObject({ pool: [ep("p")], skipIntroByFeedId: {} });
    expect(localStorage.getItem("sleepcast2.live")).toBeNull();
    expect(localStorage.getItem("sleepcast2.lastep")).toBeNull();
  });
  it("clears the removed features' keys, once", () => {
    localStorage.setItem("sleepcast2.titlevecs", "{}");
    localStorage.setItem("drift.best", "9");
    cleanStoredWebData();
    expect([localStorage.getItem("sleepcast2.titlevecs"), localStorage.getItem("drift.best")]).toEqual([null, null]);
    localStorage.setItem("drift.best", "9");
    cleanStoredWebData();
    expect(localStorage.getItem("drift.best")).toBe("9");
  });
});

describe("isYouTubeUrl", () => {
  it("knows YouTube's hosts and nothing else", () => {
    expect(isYouTubeUrl("https://www.youtube.com/@x")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/channel/UC1")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/abc")).toBe(true);
    expect(isYouTubeUrl("https://notyoutube.com/rss")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});
