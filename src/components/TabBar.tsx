import type { ReactNode } from "react";

// The app's four sections, along the bottom as a phone app has them.
export type AppTab = "podcasts" | "sleep" | "rest" | "settings";

const TABS: { id: AppTab; label: string; icon: ReactNode }[] = [
  {
    id: "podcasts",
    label: "Podcasts",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
      </svg>
    ),
  },
  {
    id: "sleep",
    label: "Sleep",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
      </svg>
    ),
  },
  {
    id: "rest",
    label: "Rest",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M5 20V12M12 20V5M19 20v-9" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
      </svg>
    ),
  },
];

export function TabBar({ tab, onTab }: { tab: AppTab; onTab: (t: AppTab) => void }) {
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-[var(--ground)] pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] pt-1.5"
    >
      <div className="mx-auto grid max-w-lg grid-cols-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`grid justify-items-center gap-0.5 py-1.5 text-[11px] font-semibold transition-colors ${
              tab === t.id ? "text-[var(--accent)]" : "text-[var(--ink-4)] hover:text-[var(--ink-3)]"
            }`}
          >
            <span className="h-[22px] w-[22px]">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>
    </nav>
  );
}
