import { useState, useEffect } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";

interface SettingsData {
  cerebras_keys: string[];
  nopecha_key: string;
  cloudflare_account_id: string;
  cloudflare_keys: string[];
  cloudflare_model: string;
  github_token: string;
}

const CLOUDFLARE_MODELS = [
  { value: "@cf/moonshotai/kimi-k2.6", label: "Kimi K2.6 (Vision)" },
  { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B Fast" },
  { value: "@cf/google/gemma-3-12b-it", label: "Gemma 3 12B" },
  { value: "@cf/qwen/qwq-32b", label: "Qwen QwQ 32B" },
];

function RevealableInput({ value, onChange, placeholder, type = "password" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex items-center">
      <input
        type={show ? "text" : type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
      />
      {type === "password" && (
        <button type="button" onClick={() => setShow(s => !s)}
          className="absolute right-3 text-slate-500 hover:text-slate-300 transition">
          {show ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

function KeyPool({ keys, onAdd, onRemove, placeholder, label }: {
  keys: string[]; onAdd: (k: string) => void; onRemove: (i: number) => void;
  placeholder?: string; label?: string;
}) {
  const [newKey, setNewKey] = useState("");
  const add = () => {
    const k = newKey.trim();
    if (!k || keys.includes(k)) return;
    onAdd(k);
    setNewKey("");
  };
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <AnimatePresence>
          {keys.length === 0 ? (
            <div className="text-center py-6 border border-dashed border-slate-800 rounded-xl">
              <p className="text-sm text-slate-600">No {label || "keys"} added yet.</p>
            </div>
          ) : keys.map((key, i) => (
            <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
              <div className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 font-mono text-xs text-slate-300 truncate">
                {key.slice(0, 10)}{"•".repeat(20)}{key.slice(-6)}
              </div>
              <button onClick={() => onRemove(i)}
                className="p-2 rounded-xl text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition flex-shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="flex gap-2">
        <input value={newKey} onChange={e => setNewKey(e.target.value)} onKeyDown={e => e.key === "Enter" && add()}
          type="password" autoComplete="off"
          className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
          placeholder={placeholder || "Enter key…"} />
        <button onClick={add} disabled={!newKey.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition">
          Add
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { supabase, user } = useSupabase();
  const [settings, setSettings] = useState<SettingsData>({
    cerebras_keys: [], nopecha_key: "",
    cloudflare_account_id: "", cloudflare_keys: [],
    cloudflare_model: "@cf/moonshotai/kimi-k2.6",
    github_token: "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState<"cerebras" | "cloudflare" | "captcha" | "github" | "system">("cerebras");
  const [testingCF, setTestingCF] = useState(false);
  const [cfTestResult, setCfTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single().then(({ data }) => {
      if (data) {
        setSettings({
          cerebras_keys: data.cerebras_keys || [],
          nopecha_key: data.nopecha_key || "",
          cloudflare_account_id: data.cloudflare_account_id || "",
          cloudflare_keys: data.cloudflare_keys || [],
          cloudflare_model: data.cloudflare_model || "@cf/moonshotai/kimi-k2.6",
          github_token: data.github_token || "",
        });
      }
      setLoading(false);
    });
  }, [supabase, user]);

  const save = async () => {
    if (!supabase || !user) return;
    setSaving(true); setError("");
    const { error } = await supabase.from("settings").upsert({
      user_id: user.id,
      cerebras_keys: settings.cerebras_keys,
      nopecha_key: settings.nopecha_key,
      cloudflare_account_id: settings.cloudflare_account_id,
      cloudflare_keys: settings.cloudflare_keys,
      cloudflare_model: settings.cloudflare_model,
      github_token: settings.github_token,
      updated_at: new Date().toISOString(),
    });
    if (error) setError(error.message);
    setSaving(false);
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
  };

  const testCloudflare = async () => {
    if (!settings.cloudflare_account_id || settings.cloudflare_keys.length === 0) {
      setCfTestResult({ ok: false, msg: "Account ID and at least one API key are required." });
      return;
    }
    setTestingCF(true); setCfTestResult(null);
    try {
      const key = settings.cloudflare_keys[0];
      const model = settings.cloudflare_model || "@cf/moonshotai/kimi-k2.6";
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflare_account_id}/ai/run/${model}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "Reply with the single word: OK" }] }),
        }
      );
      const data = await res.json();
      if (data?.result?.response) {
        setCfTestResult({ ok: true, msg: `Connected! Model response: "${data.result.response.slice(0, 60)}"` });
      } else {
        setCfTestResult({ ok: false, msg: `Unexpected response: ${JSON.stringify(data).slice(0, 120)}` });
      }
    } catch (e: any) {
      setCfTestResult({ ok: false, msg: e.message });
    }
    setTestingCF(false);
  };

  const sections = [
    { id: "cerebras",   label: "Cerebras AI",       icon: "⚡" },
    { id: "cloudflare", label: "Cloudflare AI",      icon: "☁️" },
    { id: "captcha",    label: "CAPTCHA Solver",     icon: "🛡️" },
    { id: "github",     label: "GitHub Integration", icon: "🐙" },
    { id: "system",     label: "System Info",        icon: "ℹ️" },
  ] as const;

  if (loading) return (
    <div className="flex items-center gap-3 text-slate-500 py-8">
      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
      Loading settings...
    </div>
  );

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Configure API keys, AI models, and system behavior.</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition touch-manipulation ${
              activeSection === s.id
                ? "bg-blue-600/20 text-blue-400 border-blue-600/30"
                : "text-slate-400 border-slate-800 hover:border-slate-700 hover:text-white"
            }`}>
            <span className="text-base leading-none">{s.icon}</span>
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">

        {activeSection === "cerebras" && (
          <motion.div key="cerebras" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <span className="text-purple-400">⚡</span> Cerebras AI Key Pool
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">Model: <span className="font-mono text-purple-300">gpt-oss-120b</span></p>
                  <p className="text-xs text-slate-500">Keys rotate automatically to avoid rate limits. Add unlimited keys.</p>
                </div>
                <span className="bg-purple-900/30 text-purple-300 text-xs font-bold px-3 py-1 rounded-full border border-purple-800/30 flex-shrink-0">
                  {settings.cerebras_keys.length} key{settings.cerebras_keys.length !== 1 ? "s" : ""}
                </span>
              </div>
              <KeyPool
                keys={settings.cerebras_keys}
                onAdd={k => setSettings(s => ({ ...s, cerebras_keys: [...s.cerebras_keys, k] }))}
                onRemove={i => setSettings(s => ({ ...s, cerebras_keys: s.cerebras_keys.filter((_, j) => j !== i) }))}
                placeholder="csk-…"
                label="Cerebras keys"
              />
              {settings.cerebras_keys.length > 1 && (
                <div className="p-3 bg-green-900/10 border border-green-800/30 rounded-xl">
                  <p className="text-xs text-green-400">
                    <span className="font-bold">Key rotation active:</span> {settings.cerebras_keys.length} keys cycling round-robin.
                    Estimated capacity: ~{settings.cerebras_keys.length * 60} req/min.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {activeSection === "cloudflare" && (
          <motion.div key="cloudflare" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h3 className="font-bold text-white flex items-center gap-2">
                  <span className="text-orange-400">☁️</span> Cloudflare Workers AI
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Vision AI for screenshot analysis during browser automation. Keys rotate automatically on rate limits.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Account ID</label>
                <input
                  value={settings.cloudflare_account_id}
                  onChange={e => setSettings(s => ({ ...s, cloudflare_account_id: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 transition font-mono"
                  placeholder="7d26fd976f99b5593254eb98cf594dd5"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                  AI Model
                </label>
                <select
                  value={settings.cloudflare_model}
                  onChange={e => setSettings(s => ({ ...s, cloudflare_model: e.target.value }))}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-orange-500 transition"
                >
                  {CLOUDFLARE_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-600 mt-1">Default: @cf/moonshotai/kimi-k2.6 (multimodal vision)</p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-slate-500">API Key Pool</label>
                  <span className="bg-orange-900/30 text-orange-300 text-xs font-bold px-3 py-1 rounded-full border border-orange-800/30">
                    {settings.cloudflare_keys.length} key{settings.cloudflare_keys.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <KeyPool
                  keys={settings.cloudflare_keys}
                  onAdd={k => setSettings(s => ({ ...s, cloudflare_keys: [...s.cloudflare_keys, k] }))}
                  onRemove={i => setSettings(s => ({ ...s, cloudflare_keys: s.cloudflare_keys.filter((_, j) => j !== i) }))}
                  placeholder="cfut_…"
                  label="Cloudflare keys"
                />
              </div>

              {settings.cloudflare_keys.length > 1 && (
                <div className="p-3 bg-orange-900/10 border border-orange-800/30 rounded-xl">
                  <p className="text-xs text-orange-400">
                    <span className="font-bold">Auto-rotation active:</span> {settings.cloudflare_keys.length} keys will rotate on rate limits or errors.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button onClick={testCloudflare} disabled={testingCF || !settings.cloudflare_account_id || settings.cloudflare_keys.length === 0}
                  className="flex items-center gap-2 bg-orange-600/20 border border-orange-600/30 hover:bg-orange-600/30 disabled:opacity-40 text-orange-300 px-5 py-2.5 rounded-xl text-sm font-bold transition">
                  {testingCF ? (
                    <><div className="w-4 h-4 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" /> Testing…</>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Test Connection
                    </>
                  )}
                </button>
                {cfTestResult && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                    className={`text-sm flex items-center gap-1.5 ${cfTestResult.ok ? "text-green-400" : "text-red-400"}`}>
                    {cfTestResult.ok ? "✓" : "✗"} {cfTestResult.msg}
                  </motion.span>
                )}
              </div>
            </div>
          </motion.div>
        )}

        {activeSection === "captcha" && (
          <motion.div key="captcha" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h3 className="font-bold text-white flex items-center gap-2">
                  <span className="text-green-400">🛡️</span> NopeCHA CAPTCHA Solver
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Automatically solves CAPTCHAs encountered during agent tasks.
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">NopeCHA API Key</label>
                <RevealableInput
                  value={settings.nopecha_key}
                  onChange={v => setSettings(s => ({ ...s, nopecha_key: v }))}
                  placeholder="nopecha_…"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {["reCAPTCHA v2", "reCAPTCHA v3", "hCaptcha", "CF Turnstile", "JS Challenge", "Funcaptcha"].map(t => (
                  <div key={t} className="flex items-center gap-2 p-3 bg-green-900/10 border border-green-800/20 rounded-xl">
                    <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                    <p className="text-xs font-semibold text-white">{t}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {activeSection === "github" && (
          <motion.div key="github" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h3 className="font-bold text-white flex items-center gap-2">
                  <span>🐙</span> GitHub Integration
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Add a GitHub Personal Access Token to enable <span className="text-blue-400 font-semibold">instant task execution</span> — skips the 10-minute GitHub Actions schedule and runs tasks immediately.
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Personal Access Token</label>
                <RevealableInput
                  value={settings.github_token}
                  onChange={v => setSettings(s => ({ ...s, github_token: v }))}
                  placeholder="github_pat_…"
                />
                <p className="text-[11px] text-slate-600 mt-1.5">
                  Required scopes: <span className="font-mono text-slate-500">repo, workflow</span>
                </p>
              </div>
              <div className="p-3 bg-blue-900/10 border border-blue-800/20 rounded-xl">
                <p className="text-xs text-blue-400">
                  <span className="font-bold">How it works:</span> When you click "Run Task", instead of waiting for the scheduler,
                  the app instantly triggers your GitHub Actions workflow. Tasks start in seconds, not minutes.
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {activeSection === "system" && (
          <motion.div key="system" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-1">
              <h3 className="font-bold text-white mb-4">System Status</h3>
              {[
                { label: "Cerebras AI",       ok: settings.cerebras_keys.length > 0,     detail: `${settings.cerebras_keys.length} key(s) — gpt-oss-120b` },
                { label: "Cloudflare AI",     ok: !!settings.cloudflare_account_id && settings.cloudflare_keys.length > 0, detail: settings.cloudflare_model || "@cf/moonshotai/kimi-k2.6" },
                { label: "CAPTCHA Solver",    ok: !!settings.nopecha_key,                detail: settings.nopecha_key ? "NopeCHA configured" : "Not configured" },
                { label: "Instant Execution", ok: !!settings.github_token,               detail: settings.github_token ? "GitHub PAT configured" : "Using 10-min schedule" },
                { label: "Database",          ok: true,                                  detail: "Supabase connected" },
                { label: "Browser Agent",     ok: true,                                  detail: "Playwright stealth + human-like" },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between py-2.5 border-b border-slate-800 last:border-0">
                  <div>
                    <p className="text-sm font-semibold text-white">{item.label}</p>
                    <p className="text-xs text-slate-500">{item.detail}</p>
                  </div>
                  <div className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border flex-shrink-0 ${
                    item.ok ? "bg-green-900/30 text-green-400 border-green-800/30" : "bg-amber-900/30 text-amber-400 border-amber-800/30"
                  }`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${item.ok ? "bg-green-400" : "bg-amber-400"}`} />
                    {item.ok ? "OK" : "Setup needed"}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}

      </AnimatePresence>

      {activeSection !== "system" && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg shadow-blue-600/20">
            {saving ? "Saving..." : "Save Settings"}
          </button>
          {saved && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-green-400 text-sm flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Settings saved!
            </motion.span>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}
    </div>
  );
}
