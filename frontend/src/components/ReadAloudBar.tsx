import { useEffect, useRef, useState } from "react";
import { useReadAloud } from "../readAloud";
import { useStore } from "../store";

// Floating player bar shown while read-aloud is active. Prev/Next page walk the
// paper; playback auto-advances when a page finishes.
export function ReadAloudBar() {
  const current = useStore((s) => s.current);
  const uiLang = useStore((s) => s.uiLang);
  const notify = useStore((s) => s.notify);
  const setGoto = useStore((s) => s.setGoto);

  const active = useReadAloud((s) => s.active);
  const loading = useReadAloud((s) => s.loading);
  const playing = useReadAloud((s) => s.playing);
  const page = useReadAloud((s) => s.page);
  const nPages = useReadAloud((s) => s.nPages);
  const label = useReadAloud((s) => s.label);
  const source = useReadAloud((s) => s.source);
  const error = useReadAloud((s) => s.error);
  const pauseOrResume = useReadAloud((s) => s.pauseOrResume);
  const next = useReadAloud((s) => s.next);
  const prev = useReadAloud((s) => s.prev);
  const stop = useReadAloud((s) => s.stop);

  // The page being spoken should be scrolled into view (like following along).
  const lastFollowed = useRef<number>(-1);
  useEffect(() => {
    if (!active || source !== "page") return;
    if (page === lastFollowed.current) return;
    lastFollowed.current = page;
    setGoto(page);
  }, [active, source, page, setGoto]);

  // Surface synthesis errors as a toast once.
  const [lastError, setLastError] = useState<string | null>(null);
  useEffect(() => {
    if (error && error !== lastError) {
      notify(uiLang === "zh" ? `朗读失败：${error}` : `Read aloud failed: ${error}`);
      setLastError(error);
    }
    if (!error) setLastError(null);
  }, [error, lastError, notify, uiLang]);

  if (!active || !current) return null;

  const T = {
    en: {
      title: "Read aloud",
      loading: "Synthesizing…",
      play: "▶ Play",
      pause: "⏸ Pause",
      stop: "■ Stop",
      prev: "⏮ Previous page",
      next: "⏭ Next page",
      page: (p: number) => `Page ${p + 1} / ${nPages}`,
    },
    zh: {
      title: "朗读",
      loading: "合成中…",
      play: "▶ 播放",
      pause: "⏸ 暂停",
      stop: "■ 停止",
      prev: "⏮ 上一页",
      next: "⏭ 下一页",
      page: (p: number) => `第 ${p + 1} / ${nPages} 页`,
    },
  }[uiLang];

  const isPageMode = source === "page";

  return (
    <div className="read-aloud-bar" role="region" aria-label={T.title}>
      <span className="ra-icon" aria-hidden="true">🔊</span>
      <span className="ra-label" title={label}>
        {isPageMode ? T.page(page) : label}
      </span>
      {loading && <span className="ra-status">{T.loading}</span>}
      {error && <span className="ra-status ra-error">✗</span>}
      <span className="ra-controls">
        {isPageMode && (
          <button onClick={prev} disabled={page <= 0 || loading} title={T.prev}>⏮</button>
        )}
        <button className="ra-play" onClick={pauseOrResume} disabled={loading} title={playing ? T.pause : T.play}>
          {loading ? "…" : playing ? T.pause : T.play}
        </button>
        {isPageMode && (
          <button onClick={next} disabled={page + 1 >= nPages || loading} title={T.next}>⏭</button>
        )}
        <button className="ra-stop" onClick={stop} title={T.stop}>{T.stop}</button>
      </span>
    </div>
  );
}
