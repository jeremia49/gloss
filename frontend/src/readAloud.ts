// Read-aloud (TTS) state: plays paper pages / selections through the browser's
// audio element, one page at a time, auto-advancing until stopped or the last
// page. Audio blobs are fetched from the backend (which caches synthesized
// audio on disk), so replaying a page is instant.
import { create } from "zustand";
import { api } from "./api/client";

export type ReadAloudSource = "page" | "selection" | "text";

interface ReadAloudState {
  active: boolean;
  loading: boolean;
  playing: boolean;
  source: ReadAloudSource | null;
  paperId: string | null;
  page: number;          // current page being spoken (0-based)
  nPages: number;
  label: string;         // short human label shown in the bar
  error: string | null;
  loadAbort: AbortController | null;

  start: (opts: {
    paperId: string;
    nPages: number;
    page: number;
    source?: ReadAloudSource;
    label?: string;
    text?: string;
  }) => void;
  speakSelection: (paperId: string, page: number, text: string) => void;
  stop: () => void;
  pauseOrResume: () => void;
  next: () => void;
  prev: () => void;
  _setPage: (page: number) => void;
}

// One shared audio element for the whole app — created lazily so SSR/tests
// never touch the DOM.
let audioEl: HTMLAudioElement | null = null;
function audio(): HTMLAudioElement {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = "auto";
  }
  return audioEl;
}

function cleanupLoad(get: () => ReadAloudState) {
  get().loadAbort?.abort();
}

async function playBlob(blob: Blob): Promise<void> {
  const el = audio();
  el.src = URL.createObjectURL(blob);
  // revoke the previous object URL (if any) once the new one is set
  el.onended = null;
  el.onplay = null;
  el.onpause = null;
  await el.play();
}

export const useReadAloud = create<ReadAloudState>((set, get) => ({
  active: false,
  loading: false,
  playing: false,
  source: null,
  paperId: null,
  page: 0,
  nPages: 0,
  label: "",
  error: null,
  loadAbort: null,

  start: ({ paperId, nPages, page, source = "page", label, text }) => {
    cleanupLoad(get);
    const abort = new AbortController();
    set({
      active: true,
      loading: true,
      playing: false,
      source,
      paperId,
      page,
      nPages,
      label: label || `Page ${page + 1}`,
      error: null,
      loadAbort: abort,
    });
    void (async () => {
      try {
        const blob = text
          ? await api.speakText(text)
          : await api.speakPage(paperId, page);
        if (abort.signal.aborted) return;
        await playBlob(blob);
        if (abort.signal.aborted) return;
        set({ loading: false, playing: true });
        audio().onended = () => {
          const s = get();
          if (!s.active || s.source !== "page") return;
          if (s.page + 1 < s.nPages) get().next();
          else get().stop();
        };
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        set({ loading: false, playing: false, error: message });
      }
    })();
  },

  speakSelection: (paperId, page, text) => {
    get().start({ paperId, nPages: page + 1, page, source: "selection", label: "Selection", text });
  },

  stop: () => {
    cleanupLoad(get);
    const el = audio();
    el.pause();
    el.onended = null;
    if (el.src) {
      URL.revokeObjectURL(el.src);
      el.removeAttribute("src");
    }
    set({
      active: false, loading: false, playing: false, source: null,
      paperId: null, label: "", error: null, loadAbort: null,
    });
  },

  pauseOrResume: () => {
    const el = audio();
    if (el.paused) {
      void el.play().then(() => set({ playing: true })).catch(() => {});
    } else {
      el.pause();
      set({ playing: false });
    }
  },

  next: () => {
    const s = get();
    if (!s.paperId || s.page + 1 >= s.nPages) return;
    const page = s.page + 1;
    get().start({ paperId: s.paperId, nPages: s.nPages, page, source: "page", label: `Page ${page + 1}` });
  },

  prev: () => {
    const s = get();
    if (!s.paperId || s.page <= 0) return;
    const page = s.page - 1;
    get().start({ paperId: s.paperId, nPages: s.nPages, page, source: "page", label: `Page ${page + 1}` });
  },

  _setPage: (page) => set({ page }),
}));
