import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { SummaryPanel } from "./SummaryPanel";
import { ExplainPanel } from "./ExplainPanel";
import { TranslatePanel } from "./TranslatePanel";
import { ChatPanel } from "./ChatPanel";
import { HighlightsPanel } from "./HighlightsPanel";
import { ReferencesPanel } from "./ReferencesPanel";
import { ScholarPanel } from "./ScholarPanel";
import { SkillsPanel } from "./SkillsPanel";
import { SettingsPanel } from "./SettingsPanel";
import { MindMapPanel } from "./MindMapPanel";
import { NotesPanel } from "./NotesPanel";
import { PersonalNotesPanel } from "./PersonalNotesPanel";
import { TexPanel } from "./TexPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { PluginPanel } from "./PluginPanel";
import type { PluginManifest } from "../api/client";

interface TabDefinition {
  id: string;
  en: string;
  zh: string;
  icon?: string;
  C?: () => JSX.Element;
  plugin?: PluginManifest;
  arxivOnly?: boolean;
}

const TABS: TabDefinition[] = [
  { id: "summary", en: "Summary", zh: "速览", C: SummaryPanel },
  { id: "deep-note", en: "Deep Paper Note", zh: "深度论文笔记", C: NotesPanel },
  { id: "notes", en: "Notes", zh: "我的笔记", C: PersonalNotesPanel },
  { id: "mindmap", en: "Mind Map", zh: "思维导图", C: MindMapPanel },
  { id: "chat", en: "Chat", zh: "对话", C: ChatPanel },
  { id: "explain", en: "Explain", zh: "解释", C: ExplainPanel },
  { id: "translate", en: "Translate", zh: "翻译", C: TranslatePanel },
  { id: "tex", en: "TeX", zh: "TeX 源码", C: TexPanel, arxivOnly: true },
  { id: "highlights", en: "Highlights", zh: "高亮", C: HighlightsPanel },
  { id: "references", en: "References", zh: "参考文献", C: ReferencesPanel },
  { id: "scholar", en: "Scholar", zh: "学术", C: ScholarPanel },
  { id: "skills", en: "Skills", zh: "技能", C: SkillsPanel },
  { id: "extensions", en: "Extensions", zh: "插件", C: ExtensionsPanel },
  { id: "settings", en: "Settings", zh: "设置", C: SettingsPanel },
];

export function SidePanel({ visible = true }: { visible?: boolean }) {
  const activeTab = useStore((s) => s.activeTab);
  const setTab = useStore((s) => s.setTab);
  const askAboutText = useStore((s) => s.askAboutText);
  const uiLang = useStore((s) => s.uiLang);
  const current = useStore((s) => s.current);
  const installedPlugins = useStore((s) => s.pluginSnapshot.installed);
  const [ask, setAsk] = useState<{ x: number; y: number; text: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) setAsk(null);
  }, [visible]);

  // Keep the selected tab visible in the horizontally scrolling tablet tab bar.
  // Scroll the tab strip itself — scrollIntoView would also shift the reader
  // sideways toward the off-screen drawer.
  useEffect(() => {
    if (!visible) return;
    const bar = tabsRef.current;
    const active = bar?.querySelector<HTMLElement>(".tab.active");
    if (!bar || !active) return;
    const barRect = bar.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left >= barRect.left && tabRect.right <= barRect.right) return;
    const target = bar.scrollLeft + tabRect.left - barRect.left - (barRect.width - tabRect.width) / 2;
    bar.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [activeTab, visible]);

  // iPad/Safari select text through native handles and do not emit a usable
  // mouseup, so reveal "add to chat" after the selection settles.
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (activeTab === "chat" || activeTab === "settings") return;
        const selection = window.getSelection();
        const text = selection?.toString().trim() || "";
        if (text.length < 2 || !selection || selection.rangeCount === 0) return;
        const anchor = selection.anchorNode;
        const element = anchor instanceof Element ? anchor : anchor?.parentElement;
        if (!element || !contentRef.current?.contains(element)) return;
        if (element.closest("input, textarea, [contenteditable='true']")) return;
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setAsk({
          x: Math.max(8, Math.min(rect.left, window.innerWidth - 190)),
          y: Math.max(8, Math.min(rect.bottom, window.innerHeight - 70)),
          text,
        });
      }, 240);
    };
    document.addEventListener("selectionchange", schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", schedule);
    };
  }, [activeTab]);
  // TeX tab only for arXiv papers (they have LaTeX source)
  const pluginTabs: TabDefinition[] = installedPlugins.map((plugin) => {
    const panel = plugin.contributes?.paper_sidebar;
    const icon = panel?.icon || plugin.icon || "🧩";
    return {
      id: `plugin:${plugin.id}`,
      en: panel?.tab_name || plugin.tab_name || plugin.name,
      zh: panel?.tab_name_zh || plugin.tab_name_zh || plugin.name_zh || panel?.tab_name || plugin.tab_name || plugin.name,
      icon,
      plugin,
    };
  });
  const extensionIndex = TABS.findIndex((tab) => tab.id === "extensions");
  const tabs = [
    ...TABS.slice(0, extensionIndex),
    ...pluginTabs,
    ...TABS.slice(extensionIndex),
  ].filter((t) => !t.arxivOnly || !!current?.arxiv_id);

  function onMouseUp(e: React.MouseEvent) {
    // don't offer "add to chat" from within the chat/settings tabs themselves
    if (activeTab === "chat" || activeTab === "settings") return setAsk(null);
    const text = window.getSelection()?.toString().trim() || "";
    if (text.length < 2) return setAsk(null);
    setAsk({ x: e.clientX, y: e.clientY, text });
  }

  return (
    <div className="side-panel">
      <div className="tabs" ref={tabsRef}>
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`tab${t.plugin ? " plugin-tab" : ""}${activeTab === t.id ? " active" : ""}`}
            onClick={() => {
              setTab(t.id);
              setAsk(null);
            }}
          >
            {t.plugin && <span className="plugin-tab-icon" aria-hidden="true">{t.icon}</span>}
            <span>{uiLang === "zh" ? t.zh : t.en}</span>
          </button>
        ))}
      </div>
      {/* Every panel stays mounted (hidden when inactive) so scroll position,
          mind-map pan/zoom, and in-flight work are preserved across tab switches. */}
      <div className="tab-content" ref={contentRef} onMouseUp={onMouseUp} onMouseDown={() => setAsk(null)}>
        {tabs.map((t) => {
          const C = t.C;
          return (
            <div key={t.id} className="tab-pane" style={{ display: activeTab === t.id ? "flex" : "none" }}>
              {t.plugin ? <PluginPanel plugin={t.plugin} /> : C ? <C /> : null}
            </div>
          );
        })}
      </div>
      {ask && createPortal(
        <button
          className="ask-chat-pop"
          style={{ position: "fixed", left: ask.x, top: ask.y + 10, zIndex: 80 }}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            askAboutText(ask.text);
            window.getSelection()?.removeAllRanges();
            setAsk(null);
          }}
        >
          💬 {uiLang === "zh" ? "添加到会话" : "Add to chat"}
        </button>,
        document.body,
      )}
    </div>
  );
}
