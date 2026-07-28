// The single navigation bar.
//
// Three independent switching mechanisms sit underneath this file. setAppMode()
// swaps the top-level containers, showTab() swaps the R&D views, and
// setClinicalTab() swaps the clinical panels — and the interface used to expose
// all three as separate bars, stacked. That made a newcomer learn "mode" before
// "tab", and split related work across silos that never named themselves.
//
// This is an adapter, not a replacement. Every click still goes through those
// same three functions, unchanged: what a view is and how it is shown did not
// move. Only the number of concepts the user has to hold did.
//
// It imports nothing from the application on purpose. reflectNav() is called
// from inside setAppMode/showTab/setClinicalTab so that navigation triggered by
// code — the Analyze button on a recording card, opening a patient row — moves
// the bar too, and importing those modules back would be a cycle. The handlers
// are injected once from main.ts instead.

export interface NavHandlers {
  setAppMode(mode: "rnd" | "clinical" | "home"): void;
  showTab(tabId: string): void;
  setClinicalTab(name: string): void;
}

/** What each nav button stands for, in terms of the calls that already exist. */
const SECTIONS = {
  home: { mode: "home" },
  patients: { mode: "clinical", ctab: "patients" },
  exam: { mode: "clinical", ctab: "exam" },
  chart: { mode: "clinical", ctab: "chart" },
  record: { mode: "rnd", view: "recordView" },
  analyze: { mode: "rnd", view: "analyzeView" },
  recordings: { mode: "rnd", view: "libraryView" },
} as const;

export type NavSection = keyof typeof SECTIONS;

export function isNavSection(value: string): value is NavSection {
  return Object.prototype.hasOwnProperty.call(SECTIONS, value);
}

let handlers: NavHandlers | null = null;

/** Wire every [data-nav] element, wherever it is. The bar uses .navBtn, but a
 *  call to action on the overview page is just as much a nav link and should
 *  not have to carry the bar's styling to work. */
export function initNav(bound: NavHandlers): void {
  handlers = bound;
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach(node => {
    node.addEventListener("click", () => {
      const section = node.dataset["nav"];
      if (section && isNavSection(section)) goto(section);
    });
  });
}

export function goto(section: NavSection): void {
  if (!handlers) return;
  const target = SECTIONS[section];
  handlers.setAppMode(target.mode);
  if ("view" in target) handlers.showTab(target.view);
  if ("ctab" in target) handlers.setClinicalTab(target.ctab);
  reflectNav();
}

/** Highlight the button matching what is actually on screen.
 *
 *  This reads the DOM rather than remembering the last click, which is what
 *  keeps it honest: showTab() and setClinicalTab() are also called from
 *  recording cards, patient rows and the smoke suite, and a remembered value
 *  would silently go stale every one of those times. */
export function reflectNav(): void {
  const current = currentSection();
  document.querySelectorAll<HTMLElement>(".navBtn").forEach(btn => {
    const on = btn.dataset["nav"] === current;
    btn.classList.toggle("active", on);
    if (on) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

function shown(id: string): boolean {
  const node = document.getElementById(id);
  return node !== null && !node.hidden;
}

function currentSection(): NavSection {
  if (shown("homeMode")) return "home";
  if (shown("clinicalMode")) {
    if (shown("clinExam")) return "exam";
    if (shown("clinChart")) return "chart";
    return "patients";
  }
  const view = document.querySelector(".view.activeView")?.id;
  if (view === "analyzeView") return "analyze";
  if (view === "libraryView") return "recordings";
  return "record";
}
