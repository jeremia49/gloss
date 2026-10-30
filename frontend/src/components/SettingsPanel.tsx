import { useEffect, useState } from "react";
import { api, type AiUsageSummary } from "../api/client";
import { useStore } from "../store";
import { ThemePicker } from "./ThemePicker";
import { PdfModeToggle } from "./PdfModeToggle";
import { FeatureSettingsEditor } from "./FeatureSettingsEditor";

const LANGS = [
  "中文 (Simplified Chinese)",
  "English",
  "Bahasa Indonesia",
  "日本語",
  "한국어",
  "Français",
  "Deutsch",
  "Español",
];

// reasoning-depth options per local CLI (controlled via the standard CLI flags)
const CLAUDE_EFFORT = ["", "low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORT = ["", "minimal", "low", "medium", "high"];
const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];

export function SettingsPanel() {
  const loadSettings = useStore((s) => s.loadSettings);
  const notify = useStore((s) => s.notify);
  const uiLang = useStore((s) => s.uiLang);
  const setUiLang = useStore((s) => s.setUiLang);
  const checkProvider = useStore((s) => s.checkProvider);
  const settingsFocus = useStore((s) => s.settingsFocus);
  const openFeatureSettings = useStore((s) => s.openFeatureSettings);
  const [cfg, setCfg] = useState<any>(null);
  const [providers, setProviders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  const T = {
    en: {
      testing: "Testing…",
      testBtn: "🔌 Test connection",
      ok: (provider: string, ms: number) => `✓ ${provider} OK (${ms}ms)`,
      failed: (provider: string, error: string) => `✗ ${provider} failed: ${error}`,
    },
    zh: {
      testing: "测试中…",
      testBtn: "🔌 测试连通性",
      ok: (provider: string, ms: number) => `✓ ${provider} 连通（${ms}ms）`,
      failed: (provider: string, error: string) => `✗ ${provider} 失败：${error}`,
    },
  }[uiLang];

  useEffect(() => {
    api.getSettings().then((s) => {
      setCfg(s.config);
      setProviders(s.available_providers);
    });
    void refreshUsage();
  }, []);

  async function refreshUsage() {
    setUsageLoading(true);
    try {
      setUsage(await api.getAiUsage({ limit: 20 }));
    } catch {
      // An older backend may not have the optional local usage endpoint yet.
    } finally {
      setUsageLoading(false);
    }
  }

  const formatTokens = (value: number) => new Intl.NumberFormat().format(value || 0);

  if (!cfg) return <div className="panel-body muted">Loading…</div>;

  function setProv(name: string, field: string, val: any) {
    setCfg((c: any) => ({
      ...c,
      providers: { ...c.providers, [name]: { ...c.providers[name], [field]: val } },
    }));
  }

  async function save(checkConnection = true) {
    setSaving(true);
    try {
      await api.updateSettings({
        confirm_exit: cfg.confirm_exit !== false,
        provider: cfg.provider,
        output_language: cfg.output_language,
        target_language: cfg.target_language,
        providers: cfg.providers,
        feature_settings: cfg.feature_settings || {},
      });
      await loadSettings();
      if (checkConnection) await checkProvider(cfg.provider);
      notify("Settings saved");
    } finally {
      setSaving(false);
    }
  }

  async function testConn() {
    setTesting(true);
    setTestResult(null);
    try {
      await save(false); // persist current selection/keys so we test exactly what's shown
      const r = await checkProvider(cfg.provider);
      setTestResult(
        r.ok
          ? { ok: true, text: T.ok(r.provider, r.latency_ms) }
          : { ok: false, text: T.failed(r.provider, r.error) },
      );
    } catch (e: any) {
      setTestResult({ ok: false, text: `✗ ${String(e.message || e)}` });
    } finally {
      setTesting(false);
    }
  }

  if (settingsFocus) {
    return (
      <div className="panel-body settings settings-feature-page">
        <FeatureSettingsEditor
          cfg={cfg}
          providers={providers}
          saving={saving}
          setCfg={setCfg}
          onSave={() => void save(false)}
        />
      </div>
    );
  }

  return (
    <div className="panel-body settings">
      <button className="settings-feature-entry" onClick={() => openFeatureSettings("core.summary")}>
        <span>🧩</span>
        <span>
          <strong>{uiLang === "zh" ? "插件与功能设置" : "Plugins & feature settings"}</strong>
          <small>{uiLang === "zh" ? "为总结、翻译、笔记和每个插件选择模型、推理强度及专属选项" : "Choose models, reasoning, context, and extension-specific options per feature"}</small>
        </span>
        <b>›</b>
      </button>

      <label>Interface language / 界面语言</label>
      <div className="seg">
        <button className={"seg-btn" + (uiLang === "en" ? " active" : "")} onClick={() => setUiLang("en")}>
          English
        </button>
        <button className={"seg-btn" + (uiLang === "zh" ? " active" : "")} onClick={() => setUiLang("zh")}>
          中文
        </button>
      </div>

      <label>Theme / 主题</label>
      <ThemePicker />

      <label>Reading mode / 阅读模式</label>
      <PdfModeToggle />

      <label>Exit confirmation / 退出确认</label>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={cfg.confirm_exit !== false}
          onChange={(event) => setCfg({ ...cfg, confirm_exit: event.target.checked })}
        />
        <span>{uiLang === "zh" ? "关闭应用时显示退出提醒" : "Show a confirmation before quitting the app"}</span>
      </label>

      <label>Active AI provider</label>
      <select value={cfg.provider} onChange={(e) => setCfg({ ...cfg, provider: e.target.value })}>
        {providers.map((p) => (
          <option key={p} value={p}>{p}</option>
        ))}
      </select>
      <div className="test-conn">
        <button className="small" onClick={testConn} disabled={testing}>
          {testing ? T.testing : T.testBtn}
        </button>
        {testResult && (
          <span className={"test-result " + (testResult.ok ? "ok" : "bad")}>{testResult.text}</span>
        )}
      </div>

      <label>Answer language (summary / explain / chat)</label>
      <select
        value={cfg.output_language}
        onChange={(e) => setCfg({ ...cfg, output_language: e.target.value })}
      >
        {LANGS.map((l) => <option key={l}>{l}</option>)}
      </select>

      <label>Translation target (translate feature)</label>
      <select
        value={cfg.target_language}
        onChange={(e) => setCfg({ ...cfg, target_language: e.target.value })}
      >
        {LANGS.map((l) => <option key={l}>{l}</option>)}
      </select>

      <section className="usage-card" aria-label="AI token usage">
        <div className="usage-head">
          <div>
            <strong>{uiLang === "zh" ? "AI 用量统计" : "AI usage"}</strong>
            <span>{uiLang === "zh" ? "本机保存，按完成的模型调用统计" : "Stored locally for completed model calls"}</span>
          </div>
          <button className="small" onClick={() => void refreshUsage()} disabled={usageLoading}>
            {usageLoading ? (uiLang === "zh" ? "加载中…" : "Loading…") : (uiLang === "zh" ? "刷新" : "Refresh")}
          </button>
        </div>
        {usage ? (
          <>
            <div className="usage-total">
              <span>{uiLang === "zh" ? "总计" : "Total"}<b>{formatTokens(usage.total.total_tokens)}</b></span>
              <span>{uiLang === "zh" ? "平均 / 任务" : "Average / task"}<b>{formatTokens(usage.total.average_total_tokens)}</b></span>
              <span>{uiLang === "zh" ? "任务数" : "Tasks"}<b>{formatTokens(usage.total.tasks)}</b></span>
            </div>
            {usage.by_task.length > 0 && (
              <div className="usage-by-task">
                {usage.by_task.map((row) => (
                  <div key={row.task_type}>
                    <span>{row.task_type.replaceAll("_", " ")}</span>
                    <b>{formatTokens(row.average_total_tokens)} <small>{uiLang === "zh" ? "平均" : "avg"}</small></b>
                  </div>
                ))}
              </div>
            )}
            <p className="usage-note">
              {usage.total.estimated_tasks > 0
                ? (uiLang === "zh"
                  ? `${usage.total.estimated_tasks} 个任务为估算值（本地 CLI/流式调用未返回精确 token）。`
                  : `${usage.total.estimated_tasks} task(s) are estimated because the local CLI or stream did not report exact tokens.`)
                : (uiLang === "zh" ? "所有记录均由 provider 返回精确 token。" : "All recorded tasks include provider-reported token usage.")}
            </p>
          </>
        ) : (
          <p className="usage-note">{usageLoading ? "…" : (uiLang === "zh" ? "暂无已完成的 AI 任务。" : "No completed AI tasks yet.")}</p>
        )}
      </section>

      <div className="adv-head">Advanced — local CLI models &amp; thinking depth</div>

      <fieldset>
        <legend>local_claude — subscription (no key)</legend>
        <label>model</label>
        <input list="claude-models" value={cfg.providers.local_claude.model}
          onChange={(e) => setProv("local_claude", "model", e.target.value)} />
        <datalist id="claude-models">
          {CLAUDE_MODELS.map((m) => <option key={m} value={m} />)}
        </datalist>
        <label>thinking depth (--effort)</label>
        <select value={cfg.providers.local_claude.effort || ""}
          onChange={(e) => setProv("local_claude", "effort", e.target.value)}>
          {CLAUDE_EFFORT.map((v) => <option key={v} value={v}>{v || "(default)"}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>local_codex — ChatGPT subscription (no key)</legend>
        <label>model (blank = codex default)</label>
        <input value={cfg.providers.local_codex?.model || ""}
          onChange={(e) => setProv("local_codex", "model", e.target.value)} />
        <label>reasoning effort (model_reasoning_effort)</label>
        <select value={cfg.providers.local_codex?.effort || ""}
          onChange={(e) => setProv("local_codex", "effort", e.target.value)}>
          {CODEX_EFFORT.map((v) => <option key={v} value={v}>{v || "(default)"}</option>)}
        </select>
      </fieldset>

      <fieldset>
        <legend>anthropic API</legend>
        <label>base_url</label>
        <input value={cfg.providers.anthropic.base_url || ""} placeholder="https://api.anthropic.com"
          onChange={(e) => setProv("anthropic", "base_url", e.target.value)} />
        <label>model</label>
        <input value={cfg.providers.anthropic.model}
          onChange={(e) => setProv("anthropic", "model", e.target.value)} />
        <label>api key</label>
        <input type="password" placeholder={cfg.providers.anthropic.api_key === "set" ? "•••• saved" : "sk-ant-…"}
          onChange={(e) => setProv("anthropic", "api_key", e.target.value)} />
      </fieldset>

      <fieldset>
        <legend>openai-compatible</legend>
        <label>base_url</label>
        <input value={cfg.providers.openai.base_url}
          onChange={(e) => setProv("openai", "base_url", e.target.value)} />
        <label>model</label>
        <input value={cfg.providers.openai.model}
          onChange={(e) => setProv("openai", "model", e.target.value)} />
        <label>api key</label>
        <input type="password" placeholder={cfg.providers.openai.api_key === "set" ? "•••• saved" : "sk-…"}
          onChange={(e) => setProv("openai", "api_key", e.target.value)} />
      </fieldset>

      <button className="primary" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </button>
    </div>
  );
}
