/**
 * AutoAgent Pro — Main Dashboard
 * AI: Cerebras gpt-oss-120b (primary) + Gemini 2.0 Flash (vision fallback)
 */
import { useState, useEffect, useRef } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";
import {
  Brain, Play, StopCircle, Settings, LayoutDashboard,
  PlusCircle, Trash2, RefreshCw, ChevronRight, Activity,
  CheckCircle2, XCircle, Clock, Zap, Globe, Terminal,
  Eye, EyeOff, AlertTriangle, Info, BarChart3, Key, Layers
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Task {
  id: string;
  name: string;
  prompt: string;
  status: "idle" | "pending" | "running" | "completed" | "failed";
  schedule?: string;
  last_run?: string;
  result?: { success: boolean; summary: string; stepCount: number; completedAt: string };
  created_at: string;
}

interface TaskLog {
  id: string;
  task_id: string;
  message: string;
  log_type: "info" | "success" | "error" | "warning";
  created_at: string;
}

interface SettingsData {
  cerebras_keys: string[];
  nopecha_key: string;
  gemini_key: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL_LABEL = "Cerebras gpt-oss-120b";
const MODEL_SHORT = "gpt-oss-120b";
const FALLBACK_MODEL = "Gemini 2.0 Flash";

const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "tasks", label: "Tasks", icon: Brain },
  { id: "logs", label: "Logs", icon: Terminal },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
type NavId = typeof NAV_ITEMS[number]["id"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const statusColor = (s: Task["status"]) =>
  ({ idle: "text-slate-500", pending: "text-amber-400", running: "text-blue-400", completed: "text-green-400", failed: "text-red-400" }[s] || "text-slate-400");

const statusBg = (s: Task["status"]) =>
  ({ idle: "bg-slate-800", pending: "bg-amber-900/20 border-amber-800/30", running: "bg-blue-900/20 border-blue-800/30", completed: "bg-green-900/20 border-green-800/30", failed: "bg-red-900/20 border-red-800/30" }[s] || "bg-slate-800");

const StatusIcon = ({ status }: { status: Task["status"] }) => {
  if (status === "running") return <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />;
  if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "pending") return <Clock className="w-4 h-4 text-amber-400" />;
  return <div className="w-4 h-4 rounded-full bg-slate-700" />;
};

const LogIcon = ({ type }: { type: TaskLog["log_type"] }) => {
  if (type === "success") return <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />;
  if (type === "error") return <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />;
  if (type === "warning") return <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />;
  return <Info className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />;
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ─── Components ───────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, color = "blue" }: any) {
  return (
    <div className={`bg-slate-900 border border-slate-800 rounded-2xl p-5 flex items-start justify-between`}>
      <div>
        <p className="text-xs text-slate-500 font-semibold uppercase tracking-widest mb-1">{label}</p>
        <p className="text-3xl font-extrabold text-white">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
      </div>
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-${color}-900/30 border border-${color}-800/30`}>
        <Icon className={`w-5 h-5 text-${color}-400`} />
      </div>
    </div>
  );
}

function ModelBadge() {
  return (
    <div className="flex items-center gap-1.5 bg-purple-900/20 border border-purple-800/30 rounded-full px-3 py-1">
      <Zap className="w-3 h-3 text-purple-400" />
      <span className="text-xs font-bold text-purple-300">{MODEL_SHORT}</span>
    </div>
  );
}

function CreateTaskModal({ onClose, onCreated, supabase, user }: any) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const examples = [
    "Navigate to https://news.ycombinator.com and extract the top 10 stories with their links and points",
    "Go to https://weather.com and find the weather forecast for New York City for the next 3 days",
    "Visit https://github.com/trending and list the top 5 trending repositories with their star counts",
  ];

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError("");
    const { data, error } = await supabase.from("tasks").insert({
      name: name.trim(),
      prompt: prompt.trim(),
      schedule: schedule || null,
      status: "idle",
      user_id: user?.id,
    }).select().single();
    setSaving(false);
    if (error) { setError(error.message); return; }
    onCreated(data);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl"
      >
        <div className="p-6 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="font-bold text-white text-lg">Create Agent Task</h2>
            <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
              Powered by <ModelBadge />
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-800 text-slate-500 hover:text-white transition">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Task Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              placeholder="e.g. Daily HackerNews Monitor"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Agent Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
              rows={4}
              placeholder="Describe exactly what the agent should do..."
            />
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-600 font-semibold">Examples:</p>
              {examples.map((ex, i) => (
                <button key={i} onClick={() => setPrompt(ex)}
                  className="block w-full text-left text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800 px-2 py-1 rounded-lg transition truncate">
                  {ex}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Schedule <span className="text-slate-600 normal-case font-normal">(optional — cron or interval)</span>
            </label>
            <input
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              placeholder="e.g. */30 * * * * or every_hour"
            />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
        <div className="p-6 pt-0 flex gap-3">
          <button onClick={onClose} className="flex-1 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 rounded-xl py-2.5 text-sm font-semibold transition">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || !prompt.trim() || saving}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-bold transition shadow-lg shadow-blue-600/20"
          >
            {saving ? "Creating..." : "Create Task"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Settings Page ─────────────────────────────────────────────────────────────
function SettingsPage({ supabase, user }: any) {
  const [settings, setSettings] = useState<SettingsData>({ cerebras_keys: [], nopecha_key: "", gemini_key: "" });
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revealedKeys, setRevealedKeys] = useState<Set<number>>(new Set());
  const [section, setSection] = useState<"cerebras" | "captcha" | "ai" | "status">("cerebras");

  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single().then(({ data }: any) => {
      if (data) setSettings({ cerebras_keys: data.cerebras_keys || [], nopecha_key: data.nopecha_key || "", gemini_key: data.gemini_key || "" });
      setLoading(false);
    });
  }, [supabase, user]);

  const addKey = () => {
    const k = newKey.trim();
    if (!k || settings.cerebras_keys.includes(k)) return;
    setSettings(s => ({ ...s, cerebras_keys: [...s.cerebras_keys, k] }));
    setNewKey("");
  };

  const removeKey = (i: number) => setSettings(s => ({ ...s, cerebras_keys: s.cerebras_keys.filter((_, j) => j !== i) }));

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("settings").upsert({ user_id: user.id, ...settings, updated_at: new Date().toISOString() });
    setSaving(false);
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
  };

  const sections = [
    { id: "cerebras", label: "Cerebras AI", icon: Zap },
    { id: "captcha", label: "CAPTCHA Solver", icon: Globe },
    { id: "ai", label: "Vision AI", icon: Eye },
    { id: "status", label: "System Status", icon: Activity },
  ] as const;

  if (loading) return (
    <div className="flex items-center gap-3 text-slate-500 text-sm">
      <div className="w-4 h-4 border-2 border-slate-700 border-t-blue-500 rounded-full animate-spin" />
      Loading settings...
    </div>
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Configure API keys and agent system parameters.</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition ${section === s.id ? "bg-blue-600/20 text-blue-400 border-blue-600/30" : "text-slate-400 border-slate-800 hover:border-slate-700 hover:text-white"}`}>
            <s.icon className="w-3.5 h-3.5" />
            {s.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {section === "cerebras" && (
          <motion.div key="c" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <Zap className="w-4 h-4 text-purple-400" />
                    Cerebras Key Pool
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">Model: <span className="text-purple-300 font-mono">{MODEL_LABEL}</span></p>
                  <p className="text-xs text-slate-500">Add unlimited keys — the agent rotates through them automatically to avoid rate limits.</p>
                </div>
                <span className="bg-purple-900/30 text-purple-300 text-xs font-bold px-3 py-1 rounded-full border border-purple-800/30">
                  {settings.cerebras_keys.length} key{settings.cerebras_keys.length !== 1 ? "s" : ""}
                </span>
              </div>

              <div className="space-y-2">
                <AnimatePresence>
                  {settings.cerebras_keys.length === 0 ? (
                    <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
                      <Key className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                      <p className="text-sm text-slate-600">No keys added. Add a Cerebras key below.</p>
                    </div>
                  ) : settings.cerebras_keys.map((key, i) => (
                    <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5">
                        <Zap className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                        <span className="text-xs font-mono text-slate-300 flex-1">
                          {revealedKeys.has(i) ? key : key.slice(0, 8) + "•".repeat(20) + key.slice(-6)}
                        </span>
                        <button onClick={() => setRevealedKeys(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                          className="p-1 text-slate-600 hover:text-slate-300 transition">
                          {revealedKeys.has(i) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button onClick={() => removeKey(i)} className="p-2 rounded-xl text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500">Add Cerebras Key</label>
                <div className="flex gap-2">
                  <input
                    value={newKey}
                    onChange={e => setNewKey(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addKey()}
                    type="password"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition font-mono"
                    placeholder="csk-..."
                  />
                  <button onClick={addKey} disabled={!newKey.trim()}
                    className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition">
                    Add
                  </button>
                </div>
              </div>

              {settings.cerebras_keys.length > 1 && (
                <div className="p-3 bg-purple-900/10 border border-purple-800/20 rounded-xl">
                  <p className="text-xs text-purple-300">
                    <span className="font-bold">Key rotation active</span> — {settings.cerebras_keys.length} keys cycling round-robin (~{settings.cerebras_keys.length * 60} req/min capacity)
                  </p>
                </div>
              )}
            </div>

            <button onClick={save} disabled={saving}
              className="mt-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition shadow-lg shadow-purple-600/20 flex items-center gap-2">
              {saved ? <><CheckCircle2 className="w-4 h-4" /> Saved!</> : saving ? "Saving..." : "Save Settings"}
            </button>
          </motion.div>
        )}

        {section === "captcha" && (
          <motion.div key="cap" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2"><Globe className="w-4 h-4 text-green-400" /> CAPTCHA Solver (NopeCHA)</h3>
              <p className="text-xs text-slate-500">Automatically bypasses CAPTCHAs encountered during agent tasks.</p>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">NopeCHA API Key</label>
                <input value={settings.nopecha_key} onChange={e => setSettings(s => ({ ...s, nopecha_key: e.target.value }))} type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="nopecha_..." />
              </div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                {[["reCAPTCHA v2", "✓"], ["reCAPTCHA v3", "✓"], ["hCaptcha", "✓"], ["Cloudflare Turnstile", "✓"], ["CF JS Challenge", "Auto-wait"], ["Funcaptcha", "✓"]].map(([name, s]) => (
                  <div key={name} className="flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2">
                    <span className="text-green-400 text-xs font-bold">{s}</span>
                    <span className="text-xs text-slate-400">{name}</span>
                  </div>
                ))}
              </div>
            </div>
            <button onClick={save} disabled={saving} className="mt-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition">
              {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
            </button>
          </motion.div>
        )}

        {section === "ai" && (
          <motion.div key="ai" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2"><Eye className="w-4 h-4 text-blue-400" /> Vision AI (Google Gemini)</h3>
              <p className="text-xs text-slate-500">Used as vision fallback for screenshot-based page analysis. Primary text reasoning uses Cerebras {MODEL_SHORT}.</p>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Gemini API Key</label>
                <input value={settings.gemini_key} onChange={e => setSettings(s => ({ ...s, gemini_key: e.target.value }))} type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="AIza..." />
              </div>
              <div className="grid grid-cols-2 gap-3 bg-slate-800 rounded-xl p-4 text-xs">
                <div><p className="text-slate-500">Primary (text/reasoning)</p><p className="font-mono text-purple-300 mt-0.5">{MODEL_LABEL}</p></div>
                <div><p className="text-slate-500">Fallback (vision)</p><p className="font-mono text-blue-300 mt-0.5">{FALLBACK_MODEL}</p></div>
              </div>
            </div>
            <button onClick={save} disabled={saving} className="mt-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl transition">
              {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
            </button>
          </motion.div>
        )}

        {section === "status" && (
          <motion.div key="st" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-0">
              <h3 className="font-bold text-white mb-4 flex items-center gap-2"><Activity className="w-4 h-4 text-green-400" /> System Status</h3>
              {[
                ["Primary AI", `Cerebras ${MODEL_SHORT}`, "ok"],
                ["Vision AI", FALLBACK_MODEL, "ok"],
                ["Browser Use", "Python agent (enabled)", "ok"],
                ["Playwright", "Fallback (enabled)", "ok"],
                ["Supabase", "Connected", "ok"],
                ["GitHub Actions", "10-min schedule", "ok"],
                ["GitHub Pages", "joshbond123.github.io/AutoAgent", "ok"],
                ["CAPTCHA Solver", settings.nopecha_key ? `NopeCHA configured` : "Not configured", settings.nopecha_key ? "ok" : "warn"],
                ["Cerebras Keys", `${settings.cerebras_keys.length} key(s) in pool`, settings.cerebras_keys.length > 0 ? "ok" : "warn"],
              ].map(([label, value, status]) => (
                <div key={label as string} className="flex items-center justify-between py-3 border-b border-slate-800 last:border-0">
                  <span className="text-sm text-slate-400">{label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-300">{value}</span>
                    <div className={`w-2 h-2 rounded-full ${status === "ok" ? "bg-green-400" : "bg-amber-400"}`} />
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { supabase, user, signOut } = useSupabase();
  const [nav, setNav] = useState<NavId>("overview");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadTasks = async () => {
    if (!supabase || !user) return;
    const { data } = await supabase.from("tasks").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    if (data) setTasks(data);
  };

  const loadLogs = async (taskId?: string) => {
    if (!supabase) return;
    let q = supabase.from("task_logs").select("*").order("created_at", { ascending: false }).limit(200);
    if (taskId) q = q.eq("task_id", taskId);
    const { data } = await q;
    if (data) setLogs(data.reverse());
  };

  useEffect(() => { loadTasks(); }, [supabase, user]);
  useEffect(() => { loadLogs(selectedTask?.id); }, [selectedTask, supabase]);

  // ── Real-time task updates ────────────────────────────────────────────────
  useEffect(() => {
    if (!supabase || !user) return;
    const ch = supabase.channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => loadTasks())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_logs" }, ({ new: log }) => {
        setLogs(prev => [...prev.slice(-199), log as TaskLog]);
        setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, user]);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadTasks(), loadLogs(selectedTask?.id)]);
    setRefreshing(false);
  };

  const runTask = async (task: Task) => {
    if (!supabase) return;
    await supabase.from("tasks").update({ status: "pending" }).eq("id", task.id);
    await supabase.from("task_logs").insert({ task_id: task.id, message: `Task queued for Cerebras ${MODEL_SHORT} agent`, log_type: "info" });
    await loadTasks();
  };

  const deleteTask = async (task: Task) => {
    if (!supabase || !confirm(`Delete "${task.name}"?`)) return;
    await supabase.from("task_logs").delete().eq("task_id", task.id);
    await supabase.from("tasks").delete().eq("id", task.id);
    if (selectedTask?.id === task.id) setSelectedTask(null);
    await loadTasks();
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const running = tasks.filter(t => t.status === "running").length;
  const completed = tasks.filter(t => t.status === "completed").length;
  const failed = tasks.filter(t => t.status === "failed").length;
  const pending = tasks.filter(t => t.status === "pending").length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-[#0a0a0f] text-white overflow-hidden">
      {/* Sidebar */}
      <motion.aside
        animate={{ width: sidebarOpen ? 220 : 64 }}
        className="flex-shrink-0 bg-slate-950 border-r border-slate-900 flex flex-col overflow-hidden"
      >
        {/* Logo */}
        <div className="p-4 border-b border-slate-900 flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0">
            <Brain className="w-4 h-4 text-white" />
          </div>
          {sidebarOpen && (
            <div className="overflow-hidden">
              <p className="text-sm font-extrabold text-white whitespace-nowrap">AutoAgent Pro</p>
              <p className="text-[10px] text-purple-400 font-mono whitespace-nowrap">{MODEL_SHORT}</p>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 p-2 space-y-1">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setNav(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition ${nav === id ? "bg-blue-600/20 text-blue-400" : "text-slate-500 hover:text-white hover:bg-slate-800"}`}>
              <Icon className="w-4 h-4 flex-shrink-0" />
              {sidebarOpen && <span className="whitespace-nowrap">{label}</span>}
            </button>
          ))}
        </nav>

        {/* User */}
        <div className="p-2 border-t border-slate-900">
          {sidebarOpen && (
            <div className="px-3 py-2 mb-1">
              <p className="text-xs text-slate-500 truncate">{user?.email}</p>
            </div>
          )}
          <button onClick={signOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-500 hover:text-red-400 hover:bg-red-900/10 transition">
            <XCircle className="w-4 h-4 flex-shrink-0" />
            {sidebarOpen && "Sign out"}
          </button>
        </div>
      </motion.aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="flex-shrink-0 border-b border-slate-900 bg-slate-950/50 backdrop-blur px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(s => !s)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition">
              <Layers className="w-4 h-4" />
            </button>
            <div>
              <h1 className="text-lg font-bold text-white capitalize">{nav}</h1>
              <div className="flex items-center gap-2 mt-0.5">
                <ModelBadge />
                {running > 0 && (
                  <span className="flex items-center gap-1 text-xs text-blue-400">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    {running} running
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} disabled={refreshing}
              className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition">
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            {nav === "tasks" && (
              <button onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-4 py-2 rounded-xl transition shadow-lg shadow-blue-600/20">
                <PlusCircle className="w-4 h-4" />
                New Task
              </button>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            {/* ── Overview ── */}
            {nav === "overview" && (
              <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                  <StatCard label="Total Tasks" value={tasks.length} icon={Brain} color="blue" sub="All time" />
                  <StatCard label="Running" value={running} icon={Activity} color="blue" sub={running ? "Active now" : "Idle"} />
                  <StatCard label="Completed" value={completed} icon={CheckCircle2} color="green" sub="Successfully" />
                  <StatCard label="Failed" value={failed} icon={XCircle} color="red" sub={pending ? `${pending} pending` : "No failures"} />
                </div>

                {/* AI Info card */}
                <div className="bg-slate-900 border border-purple-800/30 rounded-2xl p-6 mb-6">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0">
                      <Zap className="w-6 h-6 text-white" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-bold text-white">Cerebras Wafer-Scale Engine</h3>
                      <p className="text-sm text-slate-400 mt-1">
                        Running <span className="text-purple-300 font-mono font-bold">{MODEL_LABEL}</span> for agent reasoning.
                        Vision tasks fall back to <span className="text-blue-300">{FALLBACK_MODEL}</span>.
                        CAPTCHA solving powered by NopeCHA (reCAPTCHA, hCaptcha, Turnstile).
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        {["Ultra-fast inference", "Key rotation", "Auto CAPTCHA bypass", "Human-like browsing", "Session persistence"].map(f => (
                          <span key={f} className="text-xs bg-slate-800 text-slate-300 px-3 py-1 rounded-full">{f}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Recent tasks */}
                <div>
                  <h3 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-3">Recent Tasks</h3>
                  {tasks.length === 0 ? (
                    <div className="text-center py-12 border border-dashed border-slate-800 rounded-2xl">
                      <Brain className="w-10 h-10 text-slate-700 mx-auto mb-3" />
                      <p className="text-slate-500">No tasks yet. Create one to get started.</p>
                      <button onClick={() => { setNav("tasks"); setShowCreate(true); }}
                        className="mt-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition">
                        Create Task
                      </button>
                    </div>
                  ) : tasks.slice(0, 5).map(task => (
                    <div key={task.id} onClick={() => { setSelectedTask(task); setNav("logs"); }}
                      className={`flex items-center gap-4 p-4 rounded-xl border mb-2 cursor-pointer hover:border-slate-700 transition ${statusBg(task.status)}`}>
                      <StatusIcon status={task.status} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{task.name}</p>
                        <p className="text-xs text-slate-500 truncate">{task.prompt}</p>
                      </div>
                      <span className={`text-xs font-bold uppercase ${statusColor(task.status)}`}>{task.status}</span>
                      <ChevronRight className="w-4 h-4 text-slate-600" />
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* ── Tasks ── */}
            {nav === "tasks" && (
              <motion.div key="tasks" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-3">
                {tasks.length === 0 && (
                  <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
                    <Brain className="w-12 h-12 text-slate-700 mx-auto mb-3" />
                    <p className="text-slate-400 font-semibold">No tasks yet</p>
                    <p className="text-slate-600 text-sm mt-1">Create a task to deploy the Cerebras agent</p>
                    <button onClick={() => setShowCreate(true)}
                      className="mt-6 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition">
                      Create First Task
                    </button>
                  </div>
                )}
                {tasks.map(task => (
                  <div key={task.id} className={`p-5 rounded-2xl border ${statusBg(task.status)} transition group`}>
                    <div className="flex items-start gap-4">
                      <StatusIcon status={task.status} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-white">{task.name}</p>
                          <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full ${statusColor(task.status)}`}>
                            {task.status}
                          </span>
                          {task.schedule && (
                            <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <Clock className="w-3 h-3" />{task.schedule}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-400 mt-1 line-clamp-2">{task.prompt}</p>
                        {task.last_run && <p className="text-xs text-slate-600 mt-1">Last run: {timeAgo(task.last_run)}</p>}
                        {task.result && (
                          <p className="text-xs text-slate-500 mt-1 bg-slate-800 rounded-lg px-3 py-1.5 line-clamp-2">
                            {task.result.summary}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { setSelectedTask(task); setNav("logs"); }}
                          className="p-2 rounded-xl text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition" title="View logs">
                          <Terminal className="w-4 h-4" />
                        </button>
                        <button onClick={() => runTask(task)} disabled={task.status === "running"}
                          className="p-2 rounded-xl text-slate-500 hover:text-green-400 hover:bg-green-900/20 disabled:opacity-40 transition" title="Run now">
                          <Play className="w-4 h-4" />
                        </button>
                        <button onClick={() => deleteTask(task)}
                          className="p-2 rounded-xl text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition" title="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </motion.div>
            )}

            {/* ── Logs ── */}
            {nav === "logs" && (
              <motion.div key="logs" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
                <div className="flex items-center gap-3">
                  <select
                    value={selectedTask?.id || ""}
                    onChange={e => {
                      const t = tasks.find(t => t.id === e.target.value) || null;
                      setSelectedTask(t);
                    }}
                    className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition"
                  >
                    <option value="">All tasks</option>
                    {tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <button onClick={() => loadLogs(selectedTask?.id)}
                    className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-500">{logs.length} entries</span>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 font-mono text-xs h-[calc(100vh-280px)] overflow-y-auto space-y-1">
                  {logs.length === 0 ? (
                    <p className="text-slate-600 text-center py-8">No logs yet. Run a task to see agent output.</p>
                  ) : logs.map(log => (
                    <div key={log.id} className="flex items-start gap-2 py-0.5">
                      <span className="text-slate-600 flex-shrink-0">{new Date(log.created_at).toLocaleTimeString()}</span>
                      <LogIcon type={log.log_type} />
                      <span className={{
                        info: "text-slate-300", success: "text-green-300",
                        error: "text-red-300", warning: "text-amber-300"
                      }[log.log_type]}>{log.message}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </motion.div>
            )}

            {/* ── Settings ── */}
            {nav === "settings" && (
              <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <SettingsPage supabase={supabase} user={user} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Create task modal */}
      <AnimatePresence>
        {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={(t: Task) => { setTasks(p => [t, ...p]); setSelectedTask(t); }} supabase={supabase} user={user} />}
      </AnimatePresence>
    </div>
  );
}
