export interface OpmlFeed {
  url: string;
  title: string | null;
}

// Recursive over <outline>: any outline carrying xmlUrl is a feed, wrapper
// outlines (folders) are traversed. Attribute casing follows the OPML spec
// (xmlUrl), which DOMParser preserves for XML documents.
export function parseOpml(xml: string): OpmlFeed[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("opml")) {
    throw new Error("not an OPML document");
  }
  const feeds: OpmlFeed[] = [];
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === "outline") {
        const url = child.getAttribute("xmlUrl")?.trim();
        if (url) {
          const title =
            child.getAttribute("text")?.trim() ||
            child.getAttribute("title")?.trim() ||
            null;
          feeds.push({ url, title });
        }
        walk(child);
      }
    }
  };
  const body = doc.querySelector("opml > body");
  if (body) walk(body);
  return feeds;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

export function buildOpml(feeds: { url: string; title: string }[]): string {
  const outlines = feeds
    .map(
      (f) =>
        `    <outline type="rss" text="${escapeAttr(f.title)}" xmlUrl="${escapeAttr(f.url)}" />`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>sleepcast feeds</title></head>
  <body>
${outlines}
  </body>
</opml>
`;
}
