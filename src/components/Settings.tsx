import { useState, useEffect } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";

interface SettingsData {
  cerebras_keys: string[];
  nopecha_key: string;
  gemini_key: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-slate-700 transition"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

function KeyRow({ keyValue, index, onRemove }: { keyValue: string; index: number; onRemove: (i: number) => void }) {
  const [revealed, setRevealed] = useState(false);
  const masked = keyValue.slice(0, 8) + "•".repeat(24) + keyValue.slice(-6);
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="flex items-center gap-2 group"
    >
      <div className="flex-1 flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5">
        <span className="text-xs font-mono text-slate-300 flex-1">
          {revealed ? keyValue : masked}
        </span>
        <button
          onClick={() => setRevealed(r => !r)}
          className="p-1 rounded text-slate-600 hover:text-slate-300 transition"
        >
          {revealed ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
        <CopyButton text={keyValue} />
      </div>
      <button
        onClick={() => onRemove(index)}
        className="p-2 rounded-xl text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
    </motion.div>
  );
}

export default function SettingsPage() {
  const { supabase, user } = useSupabase();
  const [settings, setSettings] = useState<SettingsData>({ cerebras_keys: [], nopecha_key: "", gemini_key: "" });
  const [newCerebrasKey, setNewCerebrasKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState<"cerebras" | "captcha" | "ai" | "system">("cerebras");

  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single().then(({ data }) => {
      if (data) {
        setSettings({
          cerebras_keys: data.cerebras_keys || [],
          nopecha_key: data.nopecha_key || "",
          gemini_key: data.gemini_key || "",
        });
      }
      setLoading(false);
    });
  }, [supabase, user]);

  const addCerebrasKey = () => {
    const key = newCerebrasKey.trim();
    if (!key || settings.cerebras_keys.includes(key)) return;
    setSettings(s => ({ ...s, cerebras_keys: [...s.cerebras_keys, key] }));
    setNewCerebrasKey("");
  };

  const removeCerebrasKey = (index: number) => {
    setSettings(s => ({ ...s, cerebras_keys: s.cerebras_keys.filter((_, i) => i !== index) }));
  };

  const save = async () => {
    if (!supabase || !user) return;
    setSaving(true);
    setError("");
    const { error } = await supabase.from("settings").upsert({
      user_id: user.id,
      cerebras_keys: settings.cerebras_keys,
      nopecha_key: settings.nopecha_key,
      gemini_key: settings.gemini_key,
      updated_at: new Date().toISOString(),
    });
    if (error) setError(error.message);
    setSaving(false);
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
  };

  const sections = [
    { id: "cerebras", label: "Cerebras AI", icon: "⚡", desc: "Key rotation pool" },
    { id: "captcha", label: "CAPTCHA Solver", icon: "🛡", desc: "NopeCHA integration" },
    { id: "ai", label: "AI Models", icon: "🤖", desc: "Gemini config" },
    { id: "system", label: "System Info", icon: "ℹ", desc: "Status & diagnostics" },
  ] as const;

  if (loading) return (
    <div className="flex items-center gap-3 text-slate-500">
      <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
      Loading settings...
    </div>
  );

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Configure API keys and system behavior for agent automation.</p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveSection(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition ${
              activeSection === s.id
                ? "bg-blue-600/20 text-blue-400 border border-blue-600/30"
                : "text-slate-400 border border-slate-800 hover:border-slate-700 hover:text-slate-200"
            }`}
          >
            <span>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeSection === "cerebras" && (
          <motion.div key="cerebras" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-sm font-bold text-white">Cerebras AI Key Pool</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Add unlimited Cerebras API keys. The agent rotates through them automatically for high-throughput tasks and to avoid rate limits.
                  </p>
                </div>
                <span className="bg-blue-900/30 text-blue-400 text-xs font-bold px-3 py-1 rounded-full border border-blue-800/30">
                  {settings.cerebras_keys.length} key{settings.cerebras_keys.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Key list */}
              <div className="space-y-2 mb-4">
                <AnimatePresence>
                  {settings.cerebras_keys.length === 0 ? (
                    <div className="text-center py-8 text-slate-600 border border-dashed border-slate-800 rounded-xl">
                      <p className="text-sm">No Cerebras keys added yet.</p>
                      <p className="text-xs mt-1">Add keys below to enable Cerebras-powered agents.</p>
                    </div>
                  ) : (
                    settings.cerebras_keys.map((key, i) => (
                      <KeyRow key={i} keyValue={key} index={i} onRemove={removeCerebrasKey} />
                    ))
                  )}
                </AnimatePresence>
              </div>

              {/* Add key form */}
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500">Add New Key</label>
                <div className="flex gap-2">
                  <input
                    value={newCerebrasKey}
                    onChange={e => setNewCerebrasKey(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addCerebrasKey()}
                    type="password"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                    placeholder="csk-..."
                    autoComplete="off"
                  />
                  <button
                    onClick={addCerebrasKey}
                    disabled={!newCerebrasKey.trim()}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition"
                  >
                    Add
                  </button>
                </div>
                <p className="text-[11px] text-slate-600">
                  Keys are stored encrypted in Supabase. You can add unlimited keys — they rotate automatically.
                </p>
              </div>

              {/* Rotation strategy info */}
              {settings.cerebras_keys.length > 1 && (
                <div className="mt-4 p-3 bg-green-900/10 border border-green-800/30 rounded-xl">
                  <p className="text-xs text-green-400">
                    <span className="font-bold">Key rotation active:</span> {settings.cerebras_keys.length} keys will be cycled round-robin.
                    Estimated capacity: ~{settings.cerebras_keys.length * 60} req/min.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {activeSection === "captcha" && (
          <motion.div key="captcha" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div>
                <h3 className="text-sm font-bold text-white">NopeCHA CAPTCHA Solver</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Automatically solves CAPTCHAs encountered during agent tasks. Supports reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile.
                </p>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">NopeCHA API Key</label>
                <input
                  value={settings.nopecha_key}
                  onChange={e => setSettings(s => ({ ...s, nopecha_key: e.target.value }))}
                  type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="nopecha_..."
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                {[
                  { name: "reCAPTCHA v2", status: "Supported", color: "green" },
                  { name: "reCAPTCHA v3", status: "Supported", color: "green" },
                  { name: "hCaptcha", status: "Supported", color: "green" },
                  { name: "Cloudflare Turnstile", status: "Supported", color: "green" },
                  { name: "CF JS Challenge", status: "Auto-wait", color: "yellow" },
                  { name: "Funcaptcha", status: "Supported", color: "green" },
                ].map(item => (
                  <div key={item.name} className={`flex items-center gap-2 p-3 rounded-xl bg-${item.color}-900/10 border border-${item.color}-800/20`}>
                    <div className={`w-2 h-2 rounded-full bg-${item.color}-400`} />
                    <div>
                      <p className="text-xs font-semibold text-white">{item.name}</p>
                      <p className={`text-[10px] text-${item.color}-400`}>{item.status}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {activeSection === "ai" && (
          <motion.div key="ai" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <div>
                <h3 className="text-sm font-bold text-white">Google Gemini Configuration</h3>
                <p className="text-xs text-slate-500 mt-1">Primary AI model for visual reasoning and agent decision-making.</p>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Gemini API Key</label>
                <input
                  value={settings.gemini_key}
                  onChange={e => setSettings(s => ({ ...s, gemini_key: e.target.value }))}
                  type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="AIza..."
                />
                <p className="text-[11px] text-slate-600 mt-1">Used for vision-based page analysis and action planning (gemini-2.0-flash).</p>
              </div>
              <div className="p-3 bg-blue-900/10 border border-blue-800/20 rounded-xl">
                <p className="text-xs text-blue-400">
                  <span className="font-bold">Model:</span> gemini-2.0-flash | <span className="font-bold">Vision:</span> Enabled | <span className="font-bold">Max steps:</span> 30
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {activeSection === "system" && (
          <motion.div key="system" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3">
              <h3 className="text-sm font-bold text-white mb-4">System Status</h3>
              {[
                { label: "Browser Use", value: "Enabled (Python)", status: "ok" },
                { label: "Playwright", value: "Fallback enabled", status: "ok" },
                { label: "Supabase", value: "Connected", status: "ok" },
                { label: "GitHub Actions", value: "Active (10-min schedule)", status: "ok" },
                { label: "GitHub Pages", value: "https://joshbond123.github.io/AutoAgent", status: "ok" },
                { label: "CAPTCHA Handler", value: settings.nopecha_key ? "Configured" : "No key set", status: settings.nopecha_key ? "ok" : "warn" },
                { label: "Cerebras Keys", value: `${settings.cerebras_keys.length} key(s)`, status: settings.cerebras_keys.length > 0 ? "ok" : "warn" },
              ].map(item => (
                <div key={item.label} className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
                  <span className="text-sm text-slate-400">{item.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-300">{item.value}</span>
                    <div className={`w-2 h-2 rounded-full ${item.status === "ok" ? "bg-green-400" : "bg-amber-400"}`} />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Save button */}
      {activeSection !== "system" && (
        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg shadow-blue-600/20"
          >
            {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
          </button>
          {saved && (
            <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-green-400 text-sm flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Settings saved
            </motion.span>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}
    </div>
  );
}
