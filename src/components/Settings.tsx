/**
 * AutoAgent Pro — Settings v3
 * Multi-account Cloudflare credential manager, per-credential test/enable/disable,
 * auto-rotation, Cerebras key pool, NopeCHA, GitHub PAT, system status.
 * Credentials stored as JSON strings in cloudflare_keys[] array — no schema changes.
 */
import { useState, useEffect, useId } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";

// ── Types ──────────────────────────────────────────────────────────────────────
interface CFCredential {
  id: string;
  label: string;
  account_id: string;
  api_key: string;
  model: string;
  enabled: boolean;
  test_status: "ok" | "fail" | "untested";
  test_msg: string;
  last_tested: string | null;
}

interface SettingsData {
  cerebras_keys: string[];
  nopecha_key: string;
  cloudflare_credentials: CFCredential[];  // mapped from cloudflare_keys
  cloudflare_model: string;                // default model
  github_token: string;
  // raw DB fields (kept for save)
  cloudflare_account_id: string;
  cloudflare_keys: string[];
}

const CF_MODELS = [
  { value: "@cf/moonshotai/kimi-k2.6",                     label: "Kimi K2.6 (Vision + Text)" },
  { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",     label: "Llama 3.3 70B (Fast)" },
  { value: "@cf/qwen/qwq-32b",                              label: "Qwen QwQ 32B (Reasoning)" },
  { value: "@cf/google/gemma-3-12b-it",                     label: "Gemma 3 12B" },
  { value: "@cf/mistral/mistral-7b-instruct-v0.1",          label: "Mistral 7B" },
];

function nanoid(n = 12): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map(b => b.toString(36).padStart(2, "0"))
    .join("").slice(0, n);
}

// ── Serialise/deserialise credentials ──────────────────────────────────────────
/** Parse raw cloudflare_keys[] from DB, migrating legacy plain-key entries.
 *  legacyAccountId: the cloudflare_account_id DB field (used for legacy keys). */
function parseCFCredentials(raw: string[], legacyAccountId = ""): CFCredential[] {
  return (raw || []).map((item, i) => {
    try {
      const parsed = JSON.parse(item);
      if (parsed && typeof parsed === "object" && parsed.api_key) {
        return {
          id:          parsed.id          || nanoid(),
          label:       parsed.label       || `Account ${i + 1}`,
          account_id:  parsed.account_id  || legacyAccountId,
          api_key:     parsed.api_key     || "",
          model:       parsed.model       || "@cf/moonshotai/kimi-k2.6",
          enabled:     parsed.enabled !== false,
          test_status: parsed.test_status || "untested",
          test_msg:    parsed.test_msg    || "",
          last_tested: parsed.last_tested || null,
        } as CFCredential;
      }
    } catch { /* old plain-key format below */ }
    // Legacy: plain API key string — migrate using legacyAccountId from DB
    return {
      id:          nanoid(),
      label:       "Primary Account",
      account_id:  legacyAccountId,   // populated from cloudflare_account_id DB field
      api_key:     item,
      model:       "@cf/moonshotai/kimi-k2.6",
      enabled:     true,
      test_status: "untested" as const,
      test_msg:    "Migrated from legacy format — account ID pre-filled from settings.",
      last_tested: null,
    };
  });
}

function serialiseCFCredentials(creds: CFCredential[]): string[] {
  return creds.map(c => JSON.stringify({
    id:          c.id,
    label:       c.label,
    account_id:  c.account_id,
    api_key:     c.api_key,
    model:       c.model,
    enabled:     c.enabled,
    test_status: c.test_status,
    test_msg:    c.test_msg,
    last_tested: c.last_tested,
  }));
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function RevealInput({ value, onChange, placeholder, mono = true }: {
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative flex items-center">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={`w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 pr-10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition ${mono ? "font-mono" : ""}`}
      />
      <button type="button" onClick={() => setShow(s => !s)}
        className="absolute right-3 text-slate-500 hover:text-slate-300 transition">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {show
            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            : <><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></>
          }
        </svg>
      </button>
    </div>
  );
}

function CerebrasKeyPool({ keys, onAdd, onRemove }: {
  keys: string[]; onAdd: (k: string) => void; onRemove: (i: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const k = draft.trim();
    if (!k || keys.includes(k)) return;
    onAdd(k); setDraft("");
  };
  return (
    <div className="space-y-3">
      <AnimatePresence>
        {keys.length === 0 ? (
          <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="text-center py-6 border border-dashed border-slate-800 rounded-xl">
            <p className="text-sm text-slate-600">No Cerebras keys added yet.</p>
          </motion.div>
        ) : keys.map((k, i) => (
          <motion.div key={k + i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
            <div className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 font-mono text-xs text-slate-300 truncate">
              <span className="text-slate-500">{i + 1}.</span> {k.slice(0, 12)}{"•".repeat(18)}{k.slice(-6)}
            </div>
            <button onClick={() => onRemove(i)}
              className="p-2 text-slate-600 hover:text-red-400 hover:bg-red-900/20 rounded-xl transition flex-shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="flex gap-2">
        <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === "Enter" && add()}
          type="password" autoComplete="off"
          className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition font-mono"
          placeholder="csk-…" />
        <button onClick={add} disabled={!draft.trim()}
          className="bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition">
          + Add
        </button>
      </div>
    </div>
  );
}

// ── Single CF Credential card ─────────────────────────────────────────────────
function CFCredentialCard({
  cred, index, onUpdate, onDelete, onTest,
}: {
  cred: CFCredential;
  index: number;
  onUpdate: (c: CFCredential) => void;
  onDelete: () => void;
  onTest: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [testing, setTesting] = useState(false);

  const statusColors = {
    ok:       "bg-green-900/30 text-green-400 border-green-800/30",
    fail:     "bg-red-900/30 text-red-400 border-red-800/30",
    untested: "bg-slate-800 text-slate-500 border-slate-700",
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={`border rounded-2xl overflow-hidden transition ${
        cred.enabled ? "border-slate-700 bg-slate-800/50" : "border-slate-800 bg-slate-900/40 opacity-60"
      }`}>

      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Status dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          cred.test_status === "ok" ? "bg-green-400" :
          cred.test_status === "fail" ? "bg-red-400" : "bg-slate-600"
        }`} />

        {/* Label */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{cred.label || `Account ${index + 1}`}</p>
          <p className="text-[11px] text-slate-500 font-mono truncate">
            {cred.account_id ? `ID: ${cred.account_id.slice(0, 12)}…` : "⚠ No Account ID"}
            {" · "}
            {cred.api_key ? `Key: ${cred.api_key.slice(0, 8)}…` : "⚠ No API Key"}
          </p>
        </div>

        {/* Status badge */}
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 ${statusColors[cred.test_status]}`}>
          {cred.test_status === "ok" ? "✓ OK" : cred.test_status === "fail" ? "✗ Fail" : "Untested"}
        </span>

        {/* Enable toggle */}
        <button onClick={() => onUpdate({ ...cred, enabled: !cred.enabled })}
          className={`relative w-9 h-5 rounded-full transition flex-shrink-0 ${cred.enabled ? "bg-blue-600" : "bg-slate-700"}`}>
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${cred.enabled ? "left-4" : "left-0.5"}`} />
        </button>

        {/* Expand */}
        <button onClick={() => setExpanded(e => !e)}
          className="text-slate-500 hover:text-white transition flex-shrink-0">
          <svg className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Expanded edit form */}
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
            className="overflow-hidden border-t border-slate-700/50">
            <div className="px-4 py-4 space-y-3">

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">Label</label>
                  <input value={cred.label} onChange={e => onUpdate({ ...cred, label: e.target.value })}
                    placeholder="e.g. Main Account"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition" />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">AI Model</label>
                  <select value={cred.model} onChange={e => onUpdate({ ...cred, model: e.target.value })}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition">
                    {CF_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">Account ID</label>
                <input value={cred.account_id} onChange={e => onUpdate({ ...cred, account_id: e.target.value })}
                  placeholder="7d26fd976f99b5593254eb98cf594dd5"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-blue-500 transition font-mono" />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-1">API Key</label>
                <RevealInput value={cred.api_key} onChange={v => onUpdate({ ...cred, api_key: v })}
                  placeholder="cfut_…" />
              </div>

              {cred.test_msg && (
                <p className={`text-xs rounded-xl px-3 py-2 border ${
                  cred.test_status === "ok"
                    ? "bg-green-900/10 border-green-800/30 text-green-400"
                    : "bg-red-900/10 border-red-800/30 text-red-400"
                }`}>
                  {cred.test_status === "ok" ? "✓" : "✗"} {cred.test_msg}
                </p>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button onClick={async () => { setTesting(true); await onTest(); setTesting(false); }}
                  disabled={testing || !cred.account_id || !cred.api_key}
                  className="flex items-center gap-1.5 bg-orange-600/20 hover:bg-orange-600/30 disabled:opacity-40 border border-orange-600/30 text-orange-300 px-4 py-2 rounded-xl text-xs font-bold transition">
                  {testing
                    ? <><div className="w-3 h-3 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" /> Testing…</>
                    : <>⚡ Test Connection</>
                  }
                </button>
                <button onClick={onDelete}
                  className="flex items-center gap-1.5 text-slate-600 hover:text-red-400 hover:bg-red-900/20 px-4 py-2 rounded-xl text-xs font-semibold transition">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
                {cred.last_tested && (
                  <span className="text-[10px] text-slate-600 ml-auto">
                    Tested {new Date(cred.last_tested).toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ── Main SettingsPage ──────────────────────────────────────────────────────────
export default function SettingsPage({ onSettingsSaved }: { onSettingsSaved?: () => void } = {}) {
  const { supabase, user } = useSupabase();
  const [cerebrasKeys,  setCerebrasKeys]  = useState<string[]>([]);
  const [nopechaKey,    setNopechaKey]    = useState("");
  const [cfCreds,       setCfCreds]       = useState<CFCredential[]>([]);
  const [cfModel,       setCfModel]       = useState("@cf/moonshotai/kimi-k2.6");
  const [githubToken,   setGithubToken]   = useState("");
  const [saving,        setSaving]        = useState(false);
  const [saved,         setSaved]         = useState(false);
  const [loading,       setLoading]       = useState(true);
  const [saveError,     setSaveError]     = useState("");
  const [section,       setSection]       = useState<"cerebras" | "cloudflare" | "captcha" | "github" | "system">("cloudflare");

  // Load settings
  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single()
      .then(({ data }) => {
        if (data) {
          setCerebrasKeys(data.cerebras_keys || []);
          setNopechaKey(data.nopecha_key || "");
          // Pass cloudflare_account_id so legacy plain-key entries get migrated
          setCfCreds(parseCFCredentials(
            data.cloudflare_keys || [],
            data.cloudflare_account_id || ""
          ));
          setCfModel(data.cloudflare_model || "@cf/moonshotai/kimi-k2.6");
          setGithubToken(data.github_token || "");
        }
        setLoading(false);
      });
  }, [supabase, user]);

  // Save all settings
  const save = async () => {
    if (!supabase || !user || saving) return;
    setSaving(true); setSaveError("");

    const serialised = serialiseCFCredentials(cfCreds);
    const firstEnabledCred = cfCreds.find(c => c.enabled);

    const { error } = await supabase.from("settings").upsert({
      user_id:               user.id,
      cerebras_keys:         cerebrasKeys,
      nopecha_key:           nopechaKey,
      cloudflare_account_id: firstEnabledCred?.account_id || "",
      cloudflare_keys:       serialised,
      cloudflare_model:      cfModel,
      github_token:          githubToken,
      updated_at:            new Date().toISOString(),
    });

    setSaving(false);
    if (error) {
      setSaveError(error.message);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSettingsSaved?.();
    }
  };

  // Test a single CF credential
  const testCFCredential = async (idx: number) => {
    const cred = cfCreds[idx];
    if (!cred.account_id || !cred.api_key) {
      setCfCreds(prev => prev.map((c, i) => i === idx ? { ...c, test_status: "fail", test_msg: "Account ID and API key are required." } : c));
      return;
    }

    try {
      const model = cred.model || cfModel || "@cf/moonshotai/kimi-k2.6";
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cred.account_id}/ai/run/${model}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${cred.api_key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "Reply with exactly: AUTOAGENT_CF_OK" }] }),
        }
      );
      const data = await res.json();

      // Handle both OpenAI-compatible (choices) and legacy (response) formats
      const result   = data?.result || {};
      const choices  = result?.choices;
      const replyRaw = (choices?.[0]?.message?.content) || result?.response || "";
      const reply    = String(replyRaw).trim();
      const ok       = res.ok && !!reply;
      const msg      = ok
        ? `✅ Connected — model replied: "${reply.slice(0, 60)}"`
        : `❌ Error (HTTP ${res.status}): ${JSON.stringify(data).slice(0, 120)}`;

      setCfCreds(prev => prev.map((c, i) => i === idx ? {
        ...c,
        test_status: ok ? "ok" : "fail",
        test_msg: msg,
        last_tested: new Date().toISOString(),
      } : c));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCfCreds(prev => prev.map((c, i) => i === idx ? {
        ...c,
        test_status: "fail",
        test_msg: `❌ ${msg.slice(0, 120)}`,
        last_tested: new Date().toISOString(),
      } : c));
    }
  };

  const addCFCredential = () => {
    const newCred: CFCredential = {
      id:          nanoid(),
      label:       `Account ${cfCreds.length + 1}`,
      account_id:  "",
      api_key:     "",
      model:       cfModel || "@cf/moonshotai/kimi-k2.6",
      enabled:     true,
      test_status: "untested",
      test_msg:    "",
      last_tested: null,
    };
    setCfCreds(prev => [...prev, newCred]);
    // Auto-expand new credential - it renders expanded by default since expanded state is local
  };

  const updateCred = (idx: number, updated: CFCredential) => {
    setCfCreds(prev => prev.map((c, i) => i === idx ? updated : c));
  };

  const deleteCred = (idx: number) => {
    setCfCreds(prev => prev.filter((_, i) => i !== idx));
  };

  const enabledCount   = cfCreds.filter(c => c.enabled).length;
  const testedOKCount  = cfCreds.filter(c => c.test_status === "ok").length;
  const cerabrasReady  = cerebrasKeys.length > 0;
  const cfReady        = cfCreds.some(c => c.enabled && c.account_id && c.api_key);

  const SECTIONS = [
    { id: "cloudflare", label: "Cloudflare AI", icon: "☁️" },
    { id: "cerebras",   label: "Cerebras AI",   icon: "⚡" },
    { id: "captcha",    label: "CAPTCHA",        icon: "🛡️" },
    { id: "github",     label: "GitHub",         icon: "🐙" },
    { id: "system",     label: "Status",         icon: "📊" },
  ] as const;

  if (loading) {
    return (
      <div className="flex items-center gap-3 text-slate-500 py-12">
        <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-500 rounded-full animate-spin" />
        Loading settings…
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">Configure AI providers, credentials, and browser automation.</p>
      </div>

      {/* Section tabs */}
      <div className="flex gap-2 flex-wrap">
        {SECTIONS.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition ${
              section === s.id
                ? "bg-blue-600/20 text-blue-400 border-blue-500/30"
                : "text-slate-400 border-slate-800 hover:border-slate-700 hover:text-white"
            }`}>
            <span>{s.icon}</span>
            <span className="hidden sm:inline">{s.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">

        {/* ── Cloudflare AI ── */}
        {section === "cloudflare" && (
          <motion.div key="cf" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="space-y-4">
              {/* Info bar */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <span className="text-orange-400">☁️</span> Cloudflare Workers AI
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Multi-account support · Auto-rotation on rate limits · Per-credential enable/disable
                  </p>
                </div>
                <div className="flex gap-3 text-xs flex-shrink-0">
                  <div className="text-center">
                    <p className="font-bold text-white text-base">{cfCreds.length}</p>
                    <p className="text-slate-500">Total</p>
                  </div>
                  <div className="text-center">
                    <p className={`font-bold text-base ${enabledCount > 0 ? "text-green-400" : "text-slate-500"}`}>{enabledCount}</p>
                    <p className="text-slate-500">Active</p>
                  </div>
                  <div className="text-center">
                    <p className={`font-bold text-base ${testedOKCount > 0 ? "text-blue-400" : "text-slate-500"}`}>{testedOKCount}</p>
                    <p className="text-slate-500">Verified</p>
                  </div>
                </div>
              </div>

              {/* Default model selector */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl px-5 py-4">
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Default Model (used when credential has no model set)</label>
                <select value={cfModel} onChange={e => setCfModel(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-orange-500 transition">
                  {CF_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>

              {/* Credential list */}
              {cfCreds.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-slate-800 rounded-2xl">
                  <div className="text-4xl mb-3">☁️</div>
                  <p className="text-sm font-semibold text-slate-400 mb-1">No Cloudflare credentials</p>
                  <p className="text-xs text-slate-600 mb-4">Add your first Cloudflare account to enable AI vision.</p>
                  <button onClick={addCFCredential}
                    className="bg-orange-600/20 border border-orange-600/30 hover:bg-orange-600/30 text-orange-300 px-6 py-2.5 rounded-xl text-sm font-bold transition">
                    + Add First Credential
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <AnimatePresence>
                    {cfCreds.map((cred, i) => (
                      <CFCredentialCard
                        key={cred.id}
                        cred={cred}
                        index={i}
                        onUpdate={updated => updateCred(i, updated)}
                        onDelete={() => deleteCred(i)}
                        onTest={() => testCFCredential(i)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              )}

              {cfCreds.length > 0 && (
                <button onClick={addCFCredential}
                  className="w-full border border-dashed border-slate-700 hover:border-orange-600/50 hover:bg-orange-600/5 text-slate-500 hover:text-orange-300 py-3 rounded-2xl text-sm font-semibold transition flex items-center justify-center gap-2">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Another Credential
                </button>
              )}

              {enabledCount > 1 && (
                <div className="bg-orange-900/10 border border-orange-800/20 rounded-2xl px-4 py-3">
                  <p className="text-xs text-orange-400">
                    <span className="font-bold">🔄 Auto-rotation active:</span> {enabledCount} credentials will be used in round-robin order.
                    On rate limits or failures, the agent automatically switches to the next available credential.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Cerebras AI ── */}
        {section === "cerebras" && (
          <motion.div key="cerebras" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <span className="text-purple-400">⚡</span> Cerebras AI Key Pool
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Primary AI for browser decision making · Models: llama-3.3-70b, llama3.1-8b
                  </p>
                  <p className="text-xs text-slate-500">Keys rotate automatically to avoid rate limits.</p>
                </div>
                <span className={`text-xs font-bold px-3 py-1 rounded-full border flex-shrink-0 ${
                  cerabrasReady
                    ? "bg-purple-900/30 text-purple-300 border-purple-800/30"
                    : "bg-slate-800 text-slate-500 border-slate-700"
                }`}>
                  {cerebrasKeys.length} key{cerebrasKeys.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="bg-blue-900/10 border border-blue-800/20 rounded-xl px-4 py-3">
                <p className="text-xs text-blue-400">
                  <span className="font-bold">💡 Title generation:</span> Cerebras keys are also used to generate smart conversation titles automatically.
                </p>
              </div>

              <CerebrasKeyPool
                keys={cerebrasKeys}
                onAdd={k => setCerebrasKeys(p => [...p, k])}
                onRemove={i => setCerebrasKeys(p => p.filter((_, j) => j !== i))}
              />

              {cerebrasKeys.length > 1 && (
                <div className="p-3 bg-purple-900/10 border border-purple-800/20 rounded-xl">
                  <p className="text-xs text-purple-400">
                    <span className="font-bold">Key rotation active:</span> {cerebrasKeys.length} keys cycling round-robin.
                    Estimated capacity: ~{cerebrasKeys.length * 60} req/min.
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── CAPTCHA ── */}
        {section === "captcha" && (
          <motion.div key="captcha" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h3 className="font-bold text-white flex items-center gap-2">
                  <span className="text-green-400">🛡️</span> NopeCHA CAPTCHA Solver
                </h3>
                <p className="text-xs text-slate-500 mt-1">Automatically bypasses CAPTCHAs encountered during automation.</p>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">NopeCHA API Key</label>
                <RevealInput value={nopechaKey} onChange={setNopechaKey} placeholder="nopecha_…" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {["reCAPTCHA v2", "reCAPTCHA v3", "hCaptcha", "CF Turnstile", "JS Challenge", "Funcaptcha"].map(t => (
                  <div key={t} className="flex items-center gap-2 p-2.5 bg-green-900/10 border border-green-800/20 rounded-xl">
                    <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                    <p className="text-xs font-semibold text-white">{t}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {/* ── GitHub ── */}
        {section === "github" && (
          <motion.div key="github" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div>
                <h3 className="font-bold text-white flex items-center gap-2">
                  <span>🐙</span> GitHub Integration
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  GitHub PAT enables <span className="text-blue-400 font-semibold">instant task execution</span> — bypasses the 10-minute cron schedule.
                </p>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Personal Access Token</label>
                <RevealInput value={githubToken} onChange={setGithubToken} placeholder="github_pat_…" />
                <p className="text-[11px] text-slate-600 mt-1.5">Required scopes: <span className="font-mono">repo, workflow</span></p>
              </div>
              <div className="p-3 bg-blue-900/10 border border-blue-800/20 rounded-xl">
                <p className="text-xs text-blue-400">
                  <span className="font-bold">How it works:</span> When you click Run Task, the app calls GitHub API to immediately trigger the Actions workflow.
                  Without this token, tasks wait for the next 10-minute cron cycle.
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── System Status ── */}
        {section === "system" && (
          <motion.div key="system" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <h3 className="font-bold text-white mb-4">System Status</h3>
              <div className="space-y-0.5">
                {[
                  {
                    label:  "Cerebras AI",
                    ok:     cerebrasKeys.length > 0,
                    detail: cerebrasKeys.length > 0
                      ? `${cerebrasKeys.length} key(s) · llama-3.3-70b, llama3.1-8b`
                      : "No keys — add at least one key",
                  },
                  {
                    label:  "Cloudflare AI",
                    ok:     cfReady,
                    detail: cfReady
                      ? `${enabledCount} credential(s) active · ${testedOKCount} verified · ${cfModel}`
                      : "No credentials configured",
                  },
                  {
                    label:  "Auto-Rotation",
                    ok:     enabledCount > 1,
                    detail: enabledCount > 1
                      ? `${enabledCount} Cloudflare credentials rotating · ${cerebrasKeys.length > 1 ? cerebrasKeys.length + " Cerebras keys rotating" : ""}`
                      : "Add multiple credentials to enable rotation",
                  },
                  {
                    label:  "CAPTCHA Solver",
                    ok:     !!nopechaKey,
                    detail: nopechaKey ? "NopeCHA configured" : "Optional — add key to bypass CAPTCHAs",
                  },
                  {
                    label:  "Instant Execution",
                    ok:     !!githubToken,
                    detail: githubToken ? "GitHub PAT set — tasks start immediately" : "Tasks wait for 10-min schedule",
                  },
                  {
                    label:  "Database",
                    ok:     true,
                    detail: "Supabase Realtime connected",
                  },
                  {
                    label:  "Browser Agent",
                    ok:     true,
                    detail: "Playwright stealth · human-like timing · anti-detection",
                  },
                ].map(item => (
                  <div key={item.label} className="flex items-center justify-between py-3 border-b border-slate-800 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white">{item.label}</p>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.detail}</p>
                    </div>
                    <div className={`ml-4 flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border flex-shrink-0 ${
                      item.ok
                        ? "bg-green-900/30 text-green-400 border-green-800/30"
                        : "bg-amber-900/30 text-amber-400 border-amber-800/30"
                    }`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${item.ok ? "bg-green-400" : "bg-amber-400"}`} />
                      {item.ok ? "Ready" : "Setup needed"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

      </AnimatePresence>

      {/* Save button (always visible except system) */}
      {section !== "system" && (
        <div className="flex items-center gap-3 pt-2">
          <button onClick={save} disabled={saving}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg shadow-blue-600/20 flex items-center gap-2">
            {saving
              ? <><div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Saving…</>
              : "Save Settings"
            }
          </button>
          <AnimatePresence>
            {saved && (
              <motion.span initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="text-green-400 text-sm flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Saved!
              </motion.span>
            )}
            {saveError && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="text-red-400 text-sm">
                ✗ {saveError}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
