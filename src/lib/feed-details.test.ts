import { describe, it, expect } from "vitest";
import { parseItunesDuration, plainText, formatLength, typicalLength, orderEpisodes } from "./feed-details";

describe("parseItunesDuration", () => {
  it("reads h:mm:ss, mm:ss and plain seconds", () => {
    expect(parseItunesDuration("1:02:03")).toBe(3723);
    expect(parseItunesDuration("62:03")).toBe(3723);
    expect(parseItunesDuration("3723")).toBe(3723);
    expect(parseItunesDuration(" 3723.4 ")).toBe(3723);
  });
  it("is null for nothing or nonsense", () => {
    expect(parseItunesDuration(undefined)).toBeNull();
    expect(parseItunesDuration("")).toBeNull();
    expect(parseItunesDuration("0")).toBeNull();
    expect(parseItunesDuration("about an hour")).toBeNull();
    expect(parseItunesDuration("1:2:3:4")).toBeNull();
  });
});

describe("plainText", () => {
  it("drops tags and squeezes whitespace", () => {
    expect(plainText("<p>Calm <b>stories</b></p>\n\n<p>for sleep</p>", 100)).toBe("Calm stories for sleep");
  });
  it("decodes entities", () => {
    expect(plainText("Tea &amp; toast &#8212; &#x2014; &rsquo;", 100)).toBe("Tea & toast — — ’");
  });
  it("cuts on a word with an ellipsis", () => {
    expect(plainText("one two three four five", 16)).toBe("one two three…");
  });
  it("is empty for nothing", () => {
    expect(plainText(null, 10)).toBe("");
  });
});

describe("formatLength", () => {
  it("says minutes, then hours", () => {
    expect(formatLength(24 * 60)).toBe("24 min");
    expect(formatLength(20)).toBe("1 min");
    expect(formatLength(65 * 60)).toBe("1 hr 5 min");
    expect(formatLength(120 * 60)).toBe("2 hr");
  });
});

describe("typicalLength", () => {
  it("is the median of known lengths", () => {
    expect(typicalLength([600, undefined, 1800, 1200])).toBe(1200);
    expect(typicalLength([600, 1200])).toBe(900);
    expect(typicalLength([undefined])).toBeNull();
  });
});

describe("orderEpisodes", () => {
  const eps = [
    { id: "a", durationSec: 600 },
    { id: "b" },
    { id: "c", durationSec: 3000 },
    { id: "d", durationSec: 600 },
  ];
  it("keeps the feed's order for newest", () => {
    expect(orderEpisodes(eps, "newest", new Set(), {}).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });
  it("sorts longest first, unknown last, ties in feed order", () => {
    expect(orderEpisodes(eps, "longest", new Set(), {}).map((e) => e.id)).toEqual(["c", "a", "d", "b"]);
  });
  it("leaves out heard and started episodes for unplayed", () => {
    expect(orderEpisodes(eps, "unplayed", new Set(["a"]), { c: 30 }).map((e) => e.id)).toEqual(["b", "d"]);
  });
});
