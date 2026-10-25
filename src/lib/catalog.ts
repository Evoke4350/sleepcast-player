// More sleep podcasts, picked and checked, to add with a tap.
//
// Not search: a directory turns up hundreds of "sleep" shows, and most are
// generated loops, ten-minute clips or abandoned feeds that make a bad night.
// Each show here was checked (October 2026) for:
//
//  - a feed the relay can carry (well under its 32 MB limit);
//  - episodes long enough to fall asleep to (a median of 25 minutes or more);
//  - a new episode in the last few months;
//  - an audio host that sends CORS headers, so offline-audio can save it.
//    Some CDN edges send them only some of the time; an episode that can't
//    be saved still streams.
//
// Left out after checking: shows read by text-to-speech, shows for children,
// and shows whose audio hosts send no CORS headers at all.
//
// Nothing here is fetched until the show is added: the catalog is text, so
// browsing it sends nothing anywhere. An added show is an ordinary custom
// feed (addCustomFeed), on in the shuffle, removable like any other.

import { BUILTIN_FEEDS, type FeedRef } from "./store";

export type CatalogStyle = "stories" | "history" | "whispered" | "guided" | "sounds";

export const CATALOG_STYLES: { style: CatalogStyle; label: string }[] = [
  { style: "stories", label: "Stories" },
  { style: "history", label: "History and mysteries" },
  { style: "whispered", label: "Whispered" },
  { style: "guided", label: "Guided relaxation" },
  { style: "sounds", label: "Rain and sound machines" },
];

export interface CatalogShow {
  url: string;
  title: string;
  /** Who makes it. */
  by: string;
  style: CatalogStyle;
  /** One line on what it sounds like. */
  about: string;
}

export const CATALOG: CatalogShow[] = [
  {
    url: "https://feeds.megaphone.fm/ARML3332065614",
    title: "Sleepy",
    by: "Otis Gray",
    style: "stories",
    about: "Old books read in a low, slow baritone.",
  },
  {
    url: "https://feeds.simplecast.com/x7Iwqf_H",
    title: "The Sleepy Bookshelf",
    by: "Slumber Studios",
    style: "stories",
    about: "Classic novels in parts, each opening with a recap so you never lose the thread.",
  },
  {
    url: "https://feeds.acast.com/public/shows/6267be622846c00016bf0c51",
    title: "Just Sleep",
    by: "Taesha Glasgow",
    style: "stories",
    about: "Public-domain stories, read gently, one a night.",
  },
  {
    url: "https://rss.buzzsprout.com/1651672.rss",
    title: "Drift Off",
    by: "Joanne D'Amico",
    style: "stories",
    about: "Public-domain stories after a short relaxation, with no ads.",
  },
  {
    url: "https://feeds.acast.com/public/shows/65ce54158eaf00001677e712",
    title: "Listen To Sleep",
    by: "Erik Ireland",
    style: "stories",
    about: "Quiet stories from a mountain cabin, told grandfather-style.",
  },
  {
    url: "https://feeds.megaphone.fm/nightfalls",
    title: "Night Falls",
    by: "Sleepiest",
    style: "stories",
    about: "Calm original stories for adults.",
  },
  {
    url: "https://feed.podbean.com/downtosleep/feed.xml",
    title: "Down To Sleep",
    by: "Down To Sleep",
    style: "stories",
    about: "Softly read audiobooks, from Alice in Wonderland to Pride and Prejudice.",
  },
  {
    url: "https://feeds.simplecast.com/6_t5gokk",
    title: "Sleep and Sorcery",
    by: "Laurel Hostak Jones",
    style: "stories",
    about: "Folklore and fantasy, part story, part guided rest.",
  },
  {
    url: "https://feeds.acast.com/public/shows/63e334a945a81300106c87c3",
    title: "Fall asleep with Henrik",
    by: "Henrik Ståhl",
    style: "stories",
    about: "A Swedish storyteller's musings and stories, gently funny.",
  },
  {
    url: "https://feeds.megaphone.fm/thesleepretreat",
    title: "The Sleep Retreat",
    by: "James Wolner",
    style: "stories",
    about: "Long stories set inside soundscapes, about two hours each.",
  },
  {
    url: "https://feeds.megaphone.fm/sleepyhistory",
    title: "Sleepy History",
    by: "Slumber Studios",
    style: "history",
    about: "People, places and events from history, told at half speed.",
  },
  {
    url: "https://feeds.megaphone.fm/ARML2865920177",
    title: "Mysteries at Midnight",
    by: "Sleep Cove",
    style: "history",
    about: "Poirot, Holmes and Father Brown, read like bedtime stories.",
  },
  {
    url: "https://media.rss.com/dozingoff/feed.xml",
    title: "Dozing Off",
    by: "Lance Lewis",
    style: "whispered",
    about: "Bedtime stories in a deep, close ASMR voice.",
  },
  {
    url: "https://rss.buzzsprout.com/2402586.rss",
    title: "Pepperoni Pizza Dreams",
    by: "Julie G.",
    style: "whispered",
    about: "Restaurant menus, whispered. Exactly as boring as it sounds.",
  },
  {
    url: "https://feeds.megaphone.fm/ARML2818067425",
    title: "Sleep Cove",
    by: "Sleep Cove",
    style: "guided",
    about: "Sleep hypnosis, guided meditations and the odd story.",
  },
  {
    url: "https://feeds.acast.com/public/shows/60f9c4eb7dd5480012f98d21",
    title: "Tracks To Relax",
    by: "Tracks To Relax",
    style: "guided",
    about: "Guided sleep meditations for racing thoughts.",
  },
  {
    url: "https://feeds.megaphone.fm/sleepmagic",
    title: "Sleep Magic",
    by: "Sleepiest",
    style: "guided",
    about: "Sleep hypnosis from a hypnotherapist.",
  },
  {
    url: "https://feeds.acast.com/public/shows/644671378aa57e00110ae5a6",
    title: "Sleep Time",
    by: "Nicky Sutton",
    style: "guided",
    about: "Guided meditations, many in extended versions for the whole night.",
  },
  {
    url: "https://feeds.megaphone.fm/TWHOUR8962918314",
    title: "12 Hour Sound Machines",
    by: "Dwellspring",
    style: "sounds",
    about: "Fans, rain and white noise for twelve hours, with no loops or fades.",
  },
  {
    url: "https://feeds.megaphone.fm/ARML7914611814",
    title: "Sleep Sounds from Calm Cove",
    by: "Sleep Cove",
    style: "sounds",
    about: "White noise, nature sounds and ambient music, hours long.",
  },
  {
    url: "https://feeds.megaphone.fm/rain-sounds-in-stereo",
    title: "Rain Sounds in Stereo",
    by: "Natural Podcasts",
    style: "sounds",
    about: "Recorded rain, from drizzle to storms, around two hours each.",
  },
];

/** Whether this show is already one of yours (added, or built in). */
export function isAdded(show: Pick<CatalogShow, "url">, feeds: readonly Pick<FeedRef, "url">[]): boolean {
  return feeds.some((f) => f.url === show.url) || BUILTIN_FEEDS.some((f) => f.url === show.url);
}
