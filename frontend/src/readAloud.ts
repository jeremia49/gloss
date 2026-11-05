// Read-aloud (TTS) state. A paper is read paragraph by paragraph from the
// backend's reading plan (`/api/tts/plan`): each segment is one parsed text
// block, so the viewer can highlight exactly what is being spoken. Segments
// tagged as skippable (authors, e-mail, footnotes, references, …) are passed
// over while "skip" is on. Audio for the next few readable paragraphs is
// synthesized ahead of time so playback flows without gaps; the backend also
// caches audio on disk, so replays are instant.
import { create } from "zustand";
import { api, type ReadSection, type ReadSegment, type Rect } from "./api/client";
import { adjacentSection, nextReadable, sectionStart, startIndex } from "./readAloudNav.mjs";

export type ReadAloudSource = "paper" | "selection";

const LOOKAHEAD = 3; // paragraphs synthesized ahead of the one playing
const KEEP_BEHIND = 2; // decoded blobs kept for instant "previous paragraph"
const SKIP_KEY = "gloss.readAloud.skip";

interface ReadAloudState {
  active: boolean;
  /** waiting for the reading plan (paper mode) or the selection's chunks */
  preparing: boolean;
  /** waiting for the current paragraph's audio to be synthesized */
  loading: boolean;
  playing: boolean;
  source: ReadAloudSource | null;
  paperId: string | null;
  segments: ReadSegment[];
  sections: ReadSection[];
  index: number;
  /** segment indices whose audio is synthesized and ready to play */
  ready: Record<number, true>;
  skipEnabled: boolean;
  /** a section the user jumped into explicitly: read even if skip-tagged */
  forceSection: number | null;
  error: string | null;

  readPaper: (paperId: string, fromPage: number) => void;
  readSelection: (paperId: string, page: number, text: string, rects: Rect[]) => void;
  stop: () => void;
  pauseOrResume: () => void;
  nextParagraph: () => void;
  prevParagraph: () => void;
  nextSection: () => void;
  prevSection: () => void;
  jumpToSection: (section: number) => void;
  setSkipEnabled: (on: boolean) => void;
}

// One shared audio element for the whole app — created lazily so tests never
// touch the DOM.
let audioEl: HTMLAudioElement | null = null;
function audio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "auto";
  }
  return audioEl;
}
/** The shared element, for UI that follows playback time (progress bar). */
export const readAloudAudio = audio;

// Playback session bookkeeping (module-level: not UI state).
let session = 0; // bumps on start/stop — stale async work checks it and bails
let gen = 0; // bumps on every navigation — stale playAt() continuations bail
let abort = new AbortController();
let blobs = new Map<number, Promise<Blob>>();
let objectUrl: string | null = null;
const planCache = new Map<string, { segments: ReadSegment[]; sections: ReadSection[] }>();

function setSource(blob: Blob | null) {
  const el = audio();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = blob ? URL.createObjectURL(blob) : null;
  if (objectUrl) el.src = objectUrl;
  else el.removeAttribute("src");
}

function resetSession() {
  session++;
  gen++;
  abort.abort();
  abort = new AbortController();
  blobs = new Map();
  const el = audio();
  el.onended = null;
  el.pause();
  setSource(null);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function savedSkip(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useReadAloud = create<ReadAloudState>((set, get) => {
  const navOpts = () => ({ skipEnabled: get().skipEnabled, forceSection: get().forceSection });

  function synth(i: number): Promise<Blob> {
    let p = blobs.get(i);
    if (!p) {
      const sid = session;
      const seg = get().segments[i];
      p = api.speakText(seg.text, abort.signal);
      blobs.set(i, p);
      p.then(
        () => {
          if (sid === session) set((s) => ({ ready: { ...s.ready, [i]: true } }));
        },
        () => {
          if (sid === session && blobs.get(i) === p) blobs.delete(i);
        },
      );
    }
    return p;
  }

  // drop decoded audio far behind the playhead (the backend still has it on disk)
  function prune(current: number) {
    const ready = { ...get().ready };
    for (const k of [...blobs.keys()]) {
      if (k < current - KEEP_BEHIND) {
        blobs.delete(k);
        delete ready[k];
      }
    }
    set({ ready });
  }

  // synthesize the next few readable paragraphs one after another (gateways
  // throttle bursts) while the current one plays
  async function prefetch(from: number, g: number) {
    let i = from;
    for (let n = 0; n < LOOKAHEAD; n++) {
      i = nextReadable(get().segments, i, 1, navOpts());
      if (i < 0 || g !== gen) return;
      try {
        await synth(i);
      } catch {
        return; // surfaced when that paragraph is actually played
      }
    }
  }

  function advance() {
    const s = get();
    const j = nextReadable(s.segments, s.index, 1, navOpts());
    if (j < 0) get().stop();
    else void playAt(j);
  }

  async function playAt(i: number, forceSection?: number | null) {
    const s = get();
    const seg = s.segments[i];
    if (!seg) return;
    const g = ++gen;
    const el = audio();
    el.onended = null;
    el.pause();
    const force = forceSection !== undefined
      ? forceSection
      : s.forceSection === seg.section ? s.forceSection : null;
    set({ index: i, forceSection: force, loading: !s.ready[i], playing: false, error: null });
    prune(i);
    try {
      const blob = await synth(i);
      if (g !== gen) return;
      setSource(blob);
      el.onended = () => {
        if (g === gen) advance();
      };
      await el.play();
      if (g !== gen) return;
      set({ loading: false, playing: true });
      void prefetch(i, g);
    } catch (error) {
      if (g !== gen) return;
      set({ loading: false, playing: false, error: errorText(error) });
    }
  }

  function begin(source: ReadAloudSource, paperId: string) {
    resetSession();
    set({
      active: true,
      preparing: true,
      loading: false,
      playing: false,
      source,
      paperId,
      segments: [],
      sections: [],
      index: 0,
      ready: {},
      forceSection: null,
      error: null,
    });
    return session;
  }

  return {
    active: false,
    preparing: false,
    loading: false,
    playing: false,
    source: null,
    paperId: null,
    segments: [],
    sections: [],
    index: 0,
    ready: {},
    skipEnabled: savedSkip(),
    forceSection: null,
    error: null,

    readPaper: (paperId, fromPage) => {
      const sid = begin("paper", paperId);
      void (async () => {
        try {
          let plan = planCache.get(paperId);
          if (!plan) {
            plan = await api.getReadPlan(paperId);
            planCache.set(paperId, plan);
          }
          if (sid !== session) return;
          set({ segments: plan.segments, sections: plan.sections, preparing: false });
          const i = startIndex(plan.segments, fromPage, navOpts());
          if (i < 0) {
            set({ error: "nothing to read in this paper" });
            return;
          }
          await playAt(i);
        } catch (error) {
          if (sid === session) set({ preparing: false, error: errorText(error) });
        }
      })();
    },

    readSelection: (paperId, page, text, rects) => {
      const sid = begin("selection", paperId);
      void (async () => {
        try {
          const { chunks } = await api.splitSpeechText(text);
          if (sid !== session) return;
          if (!chunks.length) {
            set({ preparing: false, error: "nothing to speak" });
            return;
          }
          const segments: ReadSegment[] = chunks.map((c) => ({
            page, rects, text: c, section: 0, heading: false, skip: null,
          }));
          set({ segments, sections: [{ title: "", level: 1, start: 0 }], preparing: false });
          await playAt(0);
        } catch (error) {
          if (sid === session) set({ preparing: false, error: errorText(error) });
        }
      })();
    },

    stop: () => {
      resetSession();
      set({
        active: false, preparing: false, loading: false, playing: false, source: null,
        paperId: null, segments: [], sections: [], index: 0, ready: {},
        forceSection: null, error: null,
      });
    },

    pauseOrResume: () => {
      const s = get();
      if (s.loading || s.preparing) return;
      const el = audio();
      if (s.error && !s.playing) {
        void playAt(s.index); // retry the paragraph that failed
        return;
      }
      if (el.paused) {
        void el.play().then(() => set({ playing: true })).catch((e) => set({ error: errorText(e) }));
      } else {
        el.pause();
        set({ playing: false });
      }
    },

    nextParagraph: () => {
      const s = get();
      const j = nextReadable(s.segments, s.index, 1, navOpts());
      if (j >= 0) void playAt(j);
    },

    prevParagraph: () => {
      const s = get();
      const j = nextReadable(s.segments, s.index, -1, navOpts());
      if (j >= 0) void playAt(j);
    },

    nextSection: () => {
      const s = get();
      const hit = adjacentSection(s.segments, s.sections, s.index, 1, navOpts());
      if (hit) void playAt(hit.index, hit.forceSection);
    },

    jumpToSection: (section) => {
      const s = get();
      const hit = sectionStart(s.segments, s.sections, section, navOpts());
      if (hit) void playAt(hit.index, hit.forceSection);
    },

    prevSection: () => {
      const s = get();
      const hit = adjacentSection(s.segments, s.sections, s.index, -1, navOpts());
      if (hit) void playAt(hit.index, hit.forceSection);
    },

    setSkipEnabled: (on) => {
      try {
        localStorage.setItem(SKIP_KEY, on ? "1" : "0");
      } catch {}
      set({ skipEnabled: on });
      // the lookahead depends on what is skipped — refill it for the new rule
      if (get().playing) void prefetch(get().index, gen);
    },
  };
});
