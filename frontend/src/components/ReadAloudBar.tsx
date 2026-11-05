import { useEffect, useMemo, useState } from "react";
import { readAloudAudio, useReadAloud } from "../readAloud";
import { readableIndices } from "../readAloudNav.mjs";
import { useStore } from "../store";

const SKIP_LABELS: Record<string, { en: string; zh: string }> = {
  authors: { en: "authors", zh: "作者" },
  contact: { en: "contact", zh: "联系方式" },
  header_footer: { en: "header/footer", zh: "页眉页脚" },
  caption: { en: "caption", zh: "图表标题" },
  note: { en: "note", zh: "注释" },
  footnote: { en: "footnote", zh: "脚注" },
  math: { en: "formula", zh: "公式" },
  references: { en: "references", zh: "参考文献" },
  acknowledgments: { en: "acknowledgments", zh: "致谢" },
};

// Player bar shown while read-aloud is active: progress (spoken / synthesized
// ahead / remaining), section picker, ⏮⏭ per section, ◀▶ per paragraph, and a
// toggle for auto-skipping authors, e-mail, footnotes, references, ….
export function ReadAloudBar() {
  const current = useStore((s) => s.current);
  const uiLang = useStore((s) => s.uiLang);
  const notify = useStore((s) => s.notify);

  const ra = useReadAloud();
  const { active, preparing, loading, playing, source, segments, sections, index, ready, error } = ra;
  const opts = { skipEnabled: ra.skipEnabled, forceSection: ra.forceSection };
  const order = useMemo(
    () => readableIndices(segments, opts),
    [segments, ra.skipEnabled, ra.forceSection],
  );

  // fraction of the current paragraph already spoken (smooths the bar)
  const [within, setWithin] = useState(0);
  useEffect(() => {
    const el = readAloudAudio();
    const tick = () => setWithin(el.duration > 0 ? Math.min(1, el.currentTime / el.duration) : 0);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("loadedmetadata", tick);
    return () => {
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("loadedmetadata", tick);
    };
  }, []);
  useEffect(() => setWithin(0), [index]);

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
      preparing: "Preparing…",
      synth: (n: number, total: number) => `Synthesizing ${n} / ${total}…`,
      play: "▶ Play",
      pause: "⏸ Pause",
      retry: "↻ Retry",
      stop: "■ Stop",
      prevSec: "Previous section",
      nextSec: "Next section",
      prevPara: "Previous paragraph",
      nextPara: "Next paragraph",
      skip: "Skip extras",
      skipTip: "Skip authors, e-mail, notes, footnotes, captions, formulas, acknowledgments and references",
      skipping: (what: string) => `reading skipped part: ${what}`,
      front: "Front matter",
      selection: "Selection",
      section: "Jump to section",
    },
    zh: {
      title: "朗读",
      preparing: "准备中…",
      synth: (n: number, total: number) => `合成中 ${n} / ${total}…`,
      play: "▶ 播放",
      pause: "⏸ 暂停",
      retry: "↻ 重试",
      stop: "■ 停止",
      prevSec: "上一节",
      nextSec: "下一节",
      prevPara: "上一段",
      nextPara: "下一段",
      skip: "跳过次要内容",
      skipTip: "跳过作者、邮箱、注释、脚注、图表标题、公式、致谢和参考文献",
      skipping: (what: string) => `正在朗读被跳过的部分：${what}`,
      front: "前言信息",
      selection: "选中文字",
      section: "跳转到章节",
    },
  }[uiLang];

  const isPaper = source === "paper";
  const busy = preparing || loading;
  const pos = Math.max(0, order.indexOf(index));
  const total = order.length || 1;
  const readyAhead = order.slice(pos).filter((i) => ready[i]).length;
  const played = ((pos + (playing || !busy ? within : 0)) / total) * 100;
  const buffered = Math.min(100, ((pos + readyAhead) / total) * 100);
  const seg = segments[index];
  const curSection = seg ? seg.section : 0;
  const forcedSkip = seg?.skip && (!ra.skipEnabled || ra.forceSection === seg.section) ? seg.skip : null;

  let status = "";
  if (preparing) status = T.preparing;
  else if (loading) status = T.synth(pos + 1, total);

  const sectionTitle = (i: number) => sections[i]?.title || T.front;

  return (
    <div className="read-aloud-bar" role="region" aria-label={T.title}>
      <div className="ra-row">
        <span className="ra-icon" aria-hidden="true">🔊</span>
        {isPaper && sections.length > 1 ? (
          <select
            className="ra-section"
            title={T.section}
            value={curSection}
            onChange={(e) => ra.jumpToSection(Number(e.target.value))}
          >
            {sections.map((s, i) => (
              <option key={i} value={i}>
                {"\u00a0".repeat(Math.max(0, (s.level - 1) * 2))}
                {sectionTitle(i)}
              </option>
            ))}
          </select>
        ) : (
          <span className="ra-label">{isPaper ? sectionTitle(curSection) : T.selection}</span>
        )}
        {seg && (
          <span className="ra-status">
            {uiLang === "zh" ? `第 ${seg.page + 1} 页` : `p. ${seg.page + 1}`}
          </span>
        )}
        {status && <span className="ra-status">{status}</span>}
        {forcedSkip && (
          <span className="ra-status ra-skipnote">
            {T.skipping(SKIP_LABELS[forcedSkip]?.[uiLang] || forcedSkip)}
          </span>
        )}
        {error && <span className="ra-status ra-error" title={error}>✗</span>}
        <span className="ra-controls">
          {isPaper && (
            <label className="ra-skip" title={T.skipTip}>
              <input
                type="checkbox"
                checked={ra.skipEnabled}
                onChange={(e) => ra.setSkipEnabled(e.target.checked)}
              />
              {T.skip}
            </label>
          )}
          {isPaper && (
            <button onClick={ra.prevSection} disabled={preparing} title={T.prevSec}>⏮</button>
          )}
          <button onClick={ra.prevParagraph} disabled={preparing || pos <= 0} title={T.prevPara}>◀</button>
          <button
            className="ra-play"
            onClick={ra.pauseOrResume}
            disabled={busy}
            title={playing ? T.pause : T.play}
          >
            {busy ? "…" : error && !playing ? T.retry : playing ? T.pause : T.play}
          </button>
          <button onClick={ra.nextParagraph} disabled={preparing || pos + 1 >= order.length} title={T.nextPara}>▶</button>
          {isPaper && (
            <button onClick={ra.nextSection} disabled={preparing} title={T.nextSec}>⏭</button>
          )}
          <button className="ra-stop" onClick={ra.stop} title={T.stop}>{T.stop}</button>
        </span>
      </div>
      <div
        className={`ra-progress ${busy ? "busy" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={pos + 1}
        title={`${pos + 1} / ${total}`}
      >
        <div className="ra-progress-buffered" style={{ width: `${buffered}%` }} />
        <div className="ra-progress-played" style={{ width: `${played}%` }} />
      </div>
    </div>
  );
}
