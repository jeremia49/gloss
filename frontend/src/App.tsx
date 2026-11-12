import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { Library } from "./components/Library";
import { Outline } from "./components/Outline";
import { SidePanel } from "./components/SidePanel";
import { Logo } from "./components/Logo";
import { ProviderSwitcher } from "./components/ProviderSwitcher";
import { ExitConfirmDialog } from "./components/ExitConfirmDialog";
import { PdfViewer } from "./pdf/PdfViewer";
import { startImportJobPolling } from "./importQueue.mjs";

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export default function App() {
  const view = useStore((s) => s.view);
  const current = useStore((s) => s.current);
  const closePaper = useStore((s) => s.closePaper);
  const loadPapers = useStore((s) => s.loadPapers);
  const loadSettings = useStore((s) => s.loadSettings);
  const loadPlugins = useStore((s) => s.loadPlugins);
  const checkProvider = useStore((s) => s.checkProvider);
  const refreshProviderStatuses = useStore((s) => s.refreshProviderStatuses);
  const loadImportJobs = useStore((s) => s.loadImportJobs);
  const toast = useStore((s) => s.toast);
  const notify = useStore((s) => s.notify);
  const uiLang = useStore((s) => s.uiLang);
  const activeTab = useStore((s) => s.activeTab);

  // iPads and other tablets: the paper gets the full width and the outline /
  // side panel become slide-over drawers instead of permanently squeezed columns.
  const compact = useMediaQuery("(max-width: 1280px)");
  const [panelOpen, setPanelOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);

  const clampWidth = (w: number) => Math.min(900, Math.max(320, w));
  const [sideWidth, setSideWidth] = useState(() =>
    clampWidth(Number(localStorage.getItem("gloss.sideWidth")) || 440)
  );

  const clampOutline = (w: number) => Math.min(420, Math.max(120, w));
  const [outlineWidth, setOutlineWidth] = useState(() =>
    clampOutline(Number(localStorage.getItem("gloss.outlineWidth")) || 190)
  );
  const [outlineCollapsed, setOutlineCollapsed] = useState(() => {
    const saved = localStorage.getItem("gloss.outlineCollapsed");
    if (saved != null) return saved === "1";
    // On tablet-width screens the PDF needs the room; the outline is one tap away.
    return window.matchMedia("(max-width: 1366px)").matches;
  });
  const lastTabRef = useRef(activeTab);
  const lastPaperRef = useRef(current?.id ?? null);

  useEffect(() => {
    // apply the saved theme + PDF night mode on load (controls live in Settings)
    document.documentElement.dataset.theme = localStorage.getItem("gloss.theme") || "midnight";
    document.documentElement.dataset.pdf = localStorage.getItem("gloss.pdfMode") || "light";
    loadPapers();
    loadPlugins();
    loadSettings().then(() => {
      const activeProvider = useStore.getState().provider;
      void checkProvider(activeProvider);
    });
  }, []);

  useEffect(() => startImportJobPolling(loadImportJobs, 1000), [loadImportJobs]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshProviderStatuses(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshProviderStatuses]);

  useEffect(() => {
    localStorage.setItem("gloss.sideWidth", String(sideWidth));
  }, [sideWidth]);
  useEffect(() => {
    localStorage.setItem("gloss.outlineWidth", String(outlineWidth));
  }, [outlineWidth]);
  useEffect(() => {
    localStorage.setItem("gloss.outlineCollapsed", outlineCollapsed ? "1" : "0");
  }, [outlineCollapsed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => notify(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (view === "library") {
      setPanelOpen(false);
      setOutlineOpen(false);
    }
  }, [view]);

  useEffect(() => {
    if (!panelOpen && !outlineOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPanelOpen(false);
      setOutlineOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelOpen, outlineOpen]);

  // Actions triggered from the PDF (explain / translate / add-to-chat, tapping a
  // highlight) switch tabs. On a tablet the panel is closed, so reveal it.
  useEffect(() => {
    const paper = current?.id ?? null;
    const paperChanged = lastPaperRef.current !== paper;
    const tabChanged = lastTabRef.current !== activeTab;
    lastPaperRef.current = paper;
    lastTabRef.current = activeTab;
    if (compact && tabChanged && !paperChanged) {
      setPanelOpen(true);
      setOutlineOpen(false);
    }
  }, [activeTab, current?.id, compact]);

  const trackPointer = (onMove: (event: PointerEvent) => void) => {
    document.body.style.userSelect = "none";
    const end = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    trackPointer((move) => setSideWidth(clampWidth(window.innerWidth - move.clientX)));
  };

  const startOutlineDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    trackPointer((move) => setOutlineWidth(clampOutline(move.clientX)));
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={closePaper} style={{ cursor: "pointer" }}>
          <Logo size={20} />
          <span className="brand-name">Gloss</span>
          <span className="brand-zh">旁注</span>
        </div>
        {current && (
          <div className="crumbs">
            <button className="link" onClick={closePaper}>{uiLang === "zh" ? "← 论文库" : "← Library"}</button>
          </div>
        )}
        <div className="spacer" />
        {current && compact && (
          <div className="topbar-tools">
            <button
              className={`topbar-tool${outlineOpen ? " active" : ""}`}
              aria-label={uiLang === "zh" ? "大纲" : "Outline"}
              aria-pressed={outlineOpen}
              title={uiLang === "zh" ? "显示大纲" : "Show outline"}
              onClick={() => {
                setOutlineOpen((open) => !open);
                setPanelOpen(false);
              }}
            >
              ☰
            </button>
            <button
              className={`topbar-tool${panelOpen ? " active" : ""}`}
              aria-label={uiLang === "zh" ? "侧边面板" : "Side panel"}
              aria-pressed={panelOpen}
              title={uiLang === "zh" ? "显示侧边面板" : "Show side panel"}
              onClick={() => {
                setPanelOpen((open) => !open);
                setOutlineOpen(false);
              }}
            >
              ▤
            </button>
          </div>
        )}
        <ProviderSwitcher />
      </header>

      {view === "library" ? (
        <Library />
      ) : (
        <div className={`reader${compact ? " compact" : ""}`}>
          {!compact && outlineCollapsed ? (
            <button className="outline-expand" title={uiLang === "zh" ? "显示大纲" : "Show outline"} onClick={() => setOutlineCollapsed(false)}>
              »
            </button>
          ) : (
            <>
              <div
                className={`outline-host${compact ? " drawer" : ""}${compact && outlineOpen ? " open" : ""}`}
                style={compact ? undefined : { width: outlineWidth }}
                aria-hidden={compact && !outlineOpen ? true : undefined}
              >
                <Outline
                  onCollapse={compact ? () => setOutlineOpen(false) : () => setOutlineCollapsed(true)}
                  onNavigate={compact ? () => setOutlineOpen(false) : undefined}
                />
              </div>
              {!compact && <div className="divider" onPointerDown={startOutlineDrag} />}
            </>
          )}
          <PdfViewer />
          {!compact && <div className="divider" onPointerDown={startDrag} />}
          <div
            className={`side-host${compact ? " drawer" : ""}${compact && panelOpen ? " open" : ""}`}
            style={compact ? undefined : { width: sideWidth, flex: "0 0 auto", display: "flex" }}
            aria-hidden={compact && !panelOpen ? true : undefined}
          >
            <SidePanel visible={!compact || panelOpen} />
          </div>
          {compact && (panelOpen || outlineOpen) && (
            <div
              className="drawer-backdrop"
              onClick={() => {
                setPanelOpen(false);
                setOutlineOpen(false);
              }}
            />
          )}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
      <ExitConfirmDialog />
    </div>
  );
}
