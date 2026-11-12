import { useStore } from "../store";

// Left rail: section outline for quick navigation. Resizable + collapsible (App owns width/collapse).
export function Outline({ onCollapse, onNavigate }: { onCollapse?: () => void; onNavigate?: () => void }) {
  const pages = useStore((s) => s.pages);
  const setGoto = useStore((s) => s.setGoto);
  const uiLang = useStore((s) => s.uiLang);
  const T = {
    en: { outline: "Outline", collapse: "Collapse outline", none: "No sections detected" },
    zh: { outline: "大纲", collapse: "收起大纲", none: "未检测到章节" },
  }[uiLang];
  const sections = pages?.sections || [];
  return (
    <div className="outline">
      <div className="outline-head">
        <span>{T.outline}</span>
        {onCollapse && (
          <button className="outline-collapse" title={T.collapse} onClick={onCollapse}>
            «
          </button>
        )}
      </div>
      <div className="outline-list">
        {sections.length === 0 && (
          <div className="muted" style={{ padding: "8px 12px" }}>{T.none}</div>
        )}
        {sections.map((s, i) => (
          <div
            key={i}
            className="outline-item"
            style={{ paddingLeft: 8 + (s.level - 1) * 12 }}
            onClick={() => {
              setGoto(s.page);
              onNavigate?.();
            }}
            title={s.title}
          >
            {s.title}
          </div>
        ))}
      </div>
    </div>
  );
}
