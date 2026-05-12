/**
 * AutoAgent Pro — Main Dashboard
 * Fully responsive (mobile + desktop)
 * Chat interface replaces Logs page
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";
import {
  Brain, Play, Settings, LayoutDashboard,
  PlusCircle, Trash2, RefreshCw, ChevronRight, Activity,
  CheckCircle2, XCircle, Clock, Zap, Globe,
  Eye, EyeOff, AlertTriangle, Info, Key,
  ArrowLeft, Menu, X, MessageSquare,
  Bot, User2, ChevronDown, Cpu
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
  { id: "tasks",    label: "Tasks",    icon: Brain },
  { id: "settings", label: "Settings", icon: Settings },
] as const;
type NavId = typeof NAV_ITEMS[number]["id"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const statusColor = (s: Task["status"]) =>
  ({ idle: "text-slate-500", pending: "text-amber-400", running: "text-blue-400", completed: "text-green-400", failed: "text-red-400" }[s] ?? "text-slate-400");

const statusBg = (s: Task["status"]) =>
  ({ idle: "bg-slate-900/60 border-slate-800", pending: "bg-amber-950/30 border-amber-800/30", running: "bg-blue-950/30 border-blue-800/30", completed: "bg-green-950/30 border-green-800/30", failed: "bg-red-950/30 border-red-800/30" }[s] ?? "bg-slate-900/60 border-slate-800");

const statusBadgeBg = (s: Task["status"]) =>
  ({ idle: "bg-slate-800 text-slate-400", pending: "bg-amber-900/40 text-amber-400", running: "bg-blue-900/40 text-blue-400", completed: "bg-green-900/40 text-green-400", failed: "bg-red-900/40 text-red-400" }[s] ?? "bg-slate-800 text-slate-400");

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StatusIcon({ status }: { status: Task["status"] }) {
  if (status === "running") return <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />;
  if (status === "completed") return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  if (status === "pending") return <Clock className="w-4 h-4 text-amber-400 flex-shrink-0" />;
  return <div className="w-4 h-4 rounded-full bg-slate-700 flex-shrink-0" />;
}

function StatCard({ label, value, sub, icon: Icon, color = "blue" }: {
  label: string; value: number; sub?: string; icon: React.ElementType; color?: string;
}) {
  const colorMap: Record<string, string> = {
    blue:  "bg-blue-900/30  border-blue-800/30  text-blue-400",
    green: "bg-green-900/30 border-green-800/30 text-green-400",
    red:   "bg-red-900/30   border-red-800/30   text-red-400",
    amber: "bg-amber-900/30 border-amber-800/30 text-amber-400",
  };
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex items-start justify-between">
      <div>
        <p className="text-xs text-slate-500 font-semibold uppercase tracking-widest mb-1">{label}</p>
        <p className="text-2xl sm:text-3xl font-extrabold text-white">{value}</p>
        {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
      </div>
      <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center border flex-shrink-0 ${colorMap[color] ?? colorMap.blue}`}>
        <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
      </div>
    </div>
  );
}

function ModelBadge() {
  return (
    <div className="flex items-center gap-1.5 bg-purple-900/20 border border-purple-800/30 rounded-full px-2.5 py-1">
      <Zap className="w-3 h-3 text-purple-400" />
      <span className="text-xs font-bold text-purple-300">{MODEL_SHORT}</span>
    </div>
  );
}

// ─── Chat Message ─────────────────────────────────────────────────────────────
function ChatMessage({ log }: { log: TaskLog }) {
  const isError   = log.log_type === "error";
  const isWarning = log.log_type === "warning";
  const isSuccess = log.log_type === "success";

  const msgColor   = isError ? "text-red-300" : isWarning ? "text-amber-300" : isSuccess ? "text-green-300" : "text-slate-200";
  const bubbleBg   = isError ? "bg-red-950/30 border-red-900/40" : isWarning ? "bg-amber-950/30 border-amber-900/40" : isSuccess ? "bg-green-950/30 border-green-900/40" : "bg-slate-800/60 border-slate-700/40";
  const iconEl     = isError   ? <XCircle       className="w-3.5 h-3.5 text-red-400   flex-shrink-0 mt-0.5" /> :
                     isWarning ? <AlertTriangle  className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" /> :
                     isSuccess ? <CheckCircle2   className="w-3.5 h-3.5 text-green-400 flex-shrink-0 mt-0.5" /> :
                                 <Info           className="w-3.5 h-3.5 text-blue-400  flex-shrink-0 mt-0.5" />;

  const isScreenshot = log.message.startsWith("data:image") || log.message.startsWith("SCREENSHOT:");
  const screenshotSrc = isScreenshot ? log.message.replace("SCREENSHOT:", "").trim() : null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 items-start">
      <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot className="w-3.5 h-3.5 text-blue-400" />
      </div>
      <div className={`flex-1 rounded-2xl rounded-tl-sm border p-3 ${bubbleBg}`}>
        {screenshotSrc ? (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Eye className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-400 font-medium">Browser Screenshot</span>
            </div>
            <img src={screenshotSrc} alt="Browser screenshot" className="rounded-xl w-full max-w-sm border border-slate-700" />
          </div>
        ) : (
          <div className="flex gap-2">
            {iconEl}
            <p className={`text-sm leading-relaxed ${msgColor} break-words`}>{log.message}</p>
          </div>
        )}
        <p className="text-xs text-slate-600 mt-1.5">{new Date(log.created_at).toLocaleTimeString()}</p>
      </div>
    </motion.div>
  );
}

// ─── Task Chat Panel ──────────────────────────────────────────────────────────
function TaskChatPanel({ task, onClose, onRun, onDelete, supabase }: {
  task: Task;
  onClose: () => void;
  onRun: (t: Task) => void;
  onDelete: (t: Task) => void;
  supabase: any;
}) {
  const [logs, setLogs]         = useState<TaskLog[]>([]);
  const [loading, setLoading]   = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadLogs = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase
      .from("task_logs")
      .select("*")
      .eq("task_id", task.id)
      .order("created_at", { ascending: true })
      .limit(200);
    setLogs(data || []);
    setLoading(false);
  }, [supabase, task.id]);

  useEffect(() => {
    loadLogs();
    if (!supabase) return;
    const channel = supabase
      .channel(`task-logs-${task.id}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "task_logs",
        filter: `task_id=eq.${task.id}`,
      }, (payload: any) => {
        setLogs(prev => [...prev, payload.new as TaskLog]);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [task.id, supabase, loadLogs]);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div className="flex flex-col h-full bg-[#0a0f1e]">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm flex-shrink-0">
        <button onClick={onClose} className="p-2 -ml-1 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition touch-manipulation">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-white text-sm truncate">{task.name}</p>
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${statusBadgeBg(task.status)}`}>{task.status}</span>
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{task.prompt.slice(0, 70)}…</p>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => onRun(task)} disabled={task.status === "running" || task.status === "pending"}
            className="p-2 rounded-xl text-slate-400 hover:text-green-400 hover:bg-green-900/20 disabled:opacity-40 disabled:cursor-not-allowed transition touch-manipulation" title="Run task">
            <Play className="w-4 h-4" />
          </button>
          <button onClick={() => loadLogs()}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition touch-manipulation" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => { onDelete(task); onClose(); }}
            className="p-2 rounded-xl text-slate-400 hover:text-red-400 hover:bg-red-900/20 transition touch-manipulation" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Info bar */}
      <div className="px-4 py-2.5 bg-slate-900/40 border-b border-slate-800/50 flex-shrink-0">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <div className="flex items-center gap-1.5">
            <StatusIcon status={task.status} />
            <span className={statusColor(task.status)}>
              {task.status === "running"   ? "Agent is browsing..." :
               task.status === "completed" ? `Done · ${task.result?.stepCount ?? "?"} steps` :
               task.status === "failed"    ? "Task failed" :
               task.status === "pending"   ? "Queued for execution" : "Ready to run"}
            </span>
          </div>
          {task.last_run && <span className="text-slate-600">Last run {timeAgo(task.last_run)}</span>}
          <ModelBadge />
        </div>
        {task.result?.summary && (
          <p className="text-xs text-slate-400 mt-1.5 bg-slate-800/60 rounded-lg px-3 py-1.5 line-clamp-2">{task.result.summary}</p>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 relative" onScroll={handleScroll}>
        {/* Welcome bubble */}
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 items-start">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center flex-shrink-0">
            <Bot className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 rounded-2xl rounded-tl-sm border border-blue-900/30 bg-blue-950/20 p-3">
            <p className="text-sm text-blue-200 leading-relaxed">
              AutoAgent Pro is ready. This chat shows real-time AI reasoning, browser actions, screenshots, and task progress as the agent works.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {["Cerebras gpt-oss-120b", "Browser Use", "NopeCHA", "Human-like behavior"].map(f => (
                <span key={f} className="text-xs bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded-full border border-blue-800/30">{f}</span>
              ))}
            </div>
          </div>
        </motion.div>

        {loading ? (
          <div className="flex items-center gap-3 px-2 py-6 text-slate-500">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-blue-500 rounded-full animate-spin" />
            <span className="text-sm">Loading agent history…</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-12">
            <MessageSquare className="w-10 h-10 text-slate-700 mx-auto mb-3" />
            <p className="text-slate-500 text-sm font-medium">No activity yet</p>
            <p className="text-slate-600 text-xs mt-1">Run the task to see the AI agent's real-time reasoning, browser actions, and screenshots here.</p>
            <button onClick={() => onRun(task)} disabled={task.status === "running" || task.status === "pending"}
              className="mt-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition touch-manipulation">
              Run Task Now
            </button>
          </div>
        ) : (
          logs.map(log => <ChatMessage key={log.id} log={log} />)
        )}

        {task.status === "running" && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex gap-2.5 items-start">
            <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0">
              <Bot className="w-3.5 h-3.5 text-blue-400" />
            </div>
            <div className="bg-slate-800/60 border border-slate-700/40 rounded-2xl rounded-tl-sm p-3">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  {[0, 150, 300].map(d => (
                    <div key={d} className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
                <span className="text-xs text-blue-300">Agent is working…</span>
              </div>
            </div>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      {!autoScroll && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }}
          className="absolute bottom-20 right-5 bg-blue-600 text-white rounded-full p-2 shadow-xl shadow-blue-600/30 hover:bg-blue-500 transition z-10"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      )}

      {/* Prompt display */}
      <div className="px-4 py-3 border-t border-slate-800 bg-slate-900/80 backdrop-blur-sm flex-shrink-0">
        <div className="flex items-start gap-2.5 bg-slate-800/60 border border-slate-700/40 rounded-xl px-3 py-2.5">
          <User2 className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed line-clamp-2 flex-1">{task.prompt}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Create Task Modal ────────────────────────────────────────────────────────
function CreateTaskModal({ onClose, onCreated, supabase, user }: any) {
  const [name, setName]         = useState("");
  const [prompt, setPrompt]     = useState("");
  const [schedule, setSchedule] = useState("");
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  const examples = [
    "Navigate to https://news.ycombinator.com and extract the top 10 stories with their links and points",
    "Go to https://weather.com and find the 3-day weather forecast for New York City",
    "Visit https://github.com/trending and list the top 5 trending repos with star counts",
  ];

  const handleCreate = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    setError("");
    const { data, error } = await supabase.from("tasks").insert({
      name: name.trim(), prompt: prompt.trim(),
      schedule: schedule || null, status: "idle", user_id: user?.id,
    }).select().single();
    setSaving(false);
    if (error) { setError(error.message); return; }
    onCreated(data);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm">
      <motion.div
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 300 }}
        className="bg-slate-900 border border-slate-700 rounded-t-3xl sm:rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="p-5 sm:p-6 border-b border-slate-800 flex items-center justify-between sticky top-0 bg-slate-900 z-10 rounded-t-3xl sm:rounded-t-2xl">
          <div>
            <h2 className="font-bold text-white text-lg">Create Agent Task</h2>
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="text-xs text-slate-500">Powered by</p>
              <ModelBadge />
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-800 text-slate-500 hover:text-white transition touch-manipulation">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 sm:p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Task Name</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              placeholder="e.g. Daily HackerNews Monitor" />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Agent Prompt</label>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
              rows={4} placeholder="Describe exactly what the agent should do…" />
            <div className="mt-2 space-y-1">
              <p className="text-xs text-slate-600 font-semibold">Quick examples:</p>
              {examples.map((ex, i) => (
                <button key={i} onClick={() => setPrompt(ex)}
                  className="block w-full text-left text-xs text-slate-500 hover:text-slate-300 hover:bg-slate-800 px-3 py-2 rounded-lg transition touch-manipulation">
                  {ex}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Schedule <span className="text-slate-600 normal-case font-normal">(optional — cron)</span>
            </label>
            <input value={schedule} onChange={e => setSchedule(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              placeholder="e.g. */30 * * * *" />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
        <div className="p-5 sm:p-6 pt-0 flex gap-3">
          <button onClick={onClose} className="flex-1 border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 rounded-xl py-3 text-sm font-semibold transition touch-manipulation">Cancel</button>
          <button onClick={handleCreate} disabled={!name.trim() || !prompt.trim() || saving}
            className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-bold transition shadow-lg shadow-blue-600/20 touch-manipulation">
            {saving ? "Creating…" : "Create Task"}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
function SettingsPage({ supabase, user }: any) {
  const [settings, setSettings] = useState<SettingsData>({ cerebras_keys: [], nopecha_key: "", gemini_key: "" });
  const [newKey, setNewKey]     = useState("");
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [loading, setLoading]   = useState(true);
  const [revealedKeys, setRevealedKeys] = useState<Set<number>>(new Set());
  const [section, setSection]   = useState<"cerebras" | "captcha" | "ai" | "status">("cerebras");

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
    { id: "captcha",  label: "CAPTCHA",     icon: Globe },
    { id: "ai",       label: "Vision AI",   icon: Eye },
    { id: "status",   label: "Status",      icon: Activity },
  ] as const;

  if (loading) return (
    <div className="flex items-center gap-3 text-slate-500 text-sm py-8">
      <div className="w-4 h-4 border-2 border-slate-700 border-t-blue-500 rounded-full animate-spin" />
      Loading settings…
    </div>
  );

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Configure API keys and agent parameters.</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold border transition touch-manipulation ${section === s.id ? "bg-blue-600/20 text-blue-400 border-blue-600/30" : "text-slate-400 border-slate-800 hover:border-slate-700 hover:text-white"}`}>
            <s.icon className="w-3.5 h-3.5" />
            {s.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {section === "cerebras" && (
          <motion.div key="c" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white flex items-center gap-2"><Zap className="w-4 h-4 text-purple-400" />Cerebras Key Pool</h3>
                  <p className="text-xs text-slate-500 mt-1">Model: <span className="text-purple-300 font-mono">{MODEL_LABEL}</span></p>
                  <p className="text-xs text-slate-500">Keys auto-rotate to avoid rate limits.</p>
                </div>
                <span className="bg-purple-900/30 text-purple-300 text-xs font-bold px-3 py-1 rounded-full border border-purple-800/30 flex-shrink-0">
                  {settings.cerebras_keys.length} key{settings.cerebras_keys.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="space-y-2">
                <AnimatePresence>
                  {settings.cerebras_keys.length === 0 ? (
                    <div className="text-center py-8 border border-dashed border-slate-800 rounded-xl">
                      <Key className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                      <p className="text-sm text-slate-600">No keys added yet.</p>
                    </div>
                  ) : settings.cerebras_keys.map((key, i) => (
                    <motion.div key={i} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
                      <div className="flex-1 flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 min-w-0">
                        <Zap className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                        <span className="text-xs font-mono text-slate-300 flex-1 truncate">
                          {revealedKeys.has(i) ? key : key.slice(0, 6) + "•".repeat(16) + key.slice(-4)}
                        </span>
                        <button onClick={() => setRevealedKeys(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                          className="p-1 text-slate-600 hover:text-slate-300 transition flex-shrink-0">
                          {revealedKeys.has(i) ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button onClick={() => removeKey(i)} className="p-2 rounded-xl text-slate-600 hover:text-red-400 hover:bg-red-900/20 transition flex-shrink-0">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500">Add Key</label>
                <div className="flex gap-2">
                  <input value={newKey} onChange={e => setNewKey(e.target.value)} onKeyDown={e => e.key === "Enter" && addKey()}
                    className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                    placeholder="csk-…" />
                  <button onClick={addKey} disabled={!newKey.trim()}
                    className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-4 py-2.5 rounded-xl text-sm font-bold transition flex-shrink-0 touch-manipulation">
                    Add
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {section === "captcha" && (
          <motion.div key="cap" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2"><Globe className="w-4 h-4 text-green-400" />NopeCHA CAPTCHA Solver</h3>
              <p className="text-xs text-slate-500">Solves reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile automatically during agent tasks.</p>
              <div className="flex flex-wrap gap-2">
                {["reCAPTCHA v2", "reCAPTCHA v3", "hCaptcha", "CF Turnstile", "JS Challenge"].map(t => (
                  <span key={t} className="text-xs bg-green-900/20 text-green-300 px-2.5 py-1 rounded-full border border-green-800/30">{t}</span>
                ))}
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">NopeCHA API Key</label>
                <input value={settings.nopecha_key} onChange={e => setSettings(s => ({ ...s, nopecha_key: e.target.value }))} type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="nopecha_…" />
              </div>
            </div>
          </motion.div>
        )}

        {section === "ai" && (
          <motion.div key="ai" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2"><Eye className="w-4 h-4 text-blue-400" />Vision AI ({FALLBACK_MODEL})</h3>
              <p className="text-xs text-slate-500">Used for screenshot analysis and vision-based control when Cerebras text reasoning needs visual context.</p>
              <div>
                <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Gemini API Key</label>
                <input value={settings.gemini_key} onChange={e => setSettings(s => ({ ...s, gemini_key: e.target.value }))} type="password"
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
                  placeholder="AIza…" />
              </div>
            </div>
          </motion.div>
        )}

        {section === "status" && (
          <motion.div key="st" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <h3 className="font-bold text-white flex items-center gap-2"><Activity className="w-4 h-4 text-green-400" />System Status</h3>
              {[
                { name: "Cerebras AI",     ok: settings.cerebras_keys.length > 0, detail: `${settings.cerebras_keys.length} key(s) configured` },
                { name: "CAPTCHA Solver",  ok: !!settings.nopecha_key,            detail: settings.nopecha_key ? "NopeCHA configured" : "Not configured" },
                { name: "Vision AI",       ok: !!settings.gemini_key,             detail: settings.gemini_key ? "Gemini configured" : "Not configured" },
                { name: "Database",        ok: true,                              detail: "Supabase connected" },
                { name: "Browser Agent",   ok: true,                              detail: "Playwright + Browser Use" },
              ].map(item => (
                <div key={item.name} className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">{item.name}</p>
                    <p className="text-xs text-slate-500">{item.detail}</p>
                  </div>
                  <div className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 border ${item.ok ? "bg-green-900/30 text-green-400 border-green-800/30" : "bg-amber-900/30 text-amber-400 border-amber-800/30"}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${item.ok ? "bg-green-400" : "bg-amber-400"}`} />
                    {item.ok ? "OK" : "Setup needed"}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button onClick={save} disabled={saving}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl py-3 text-sm font-bold transition shadow-lg shadow-blue-600/20 touch-manipulation">
        {saving ? "Saving…" : saved ? "✓ Saved!" : "Save Settings"}
      </button>
    </div>
  );
}

// ─── Overview Page ────────────────────────────────────────────────────────────
function OverviewPage({ tasks, onOpenTask, onCreateTask }: {
  tasks: Task[]; onOpenTask: (t: Task) => void; onCreateTask: () => void;
}) {
  const running   = tasks.filter(t => t.status === "running").length;
  const completed = tasks.filter(t => t.status === "completed").length;
  const failed    = tasks.filter(t => t.status === "failed").length;

  return (
    <motion.div key="overview" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <StatCard label="Total"   value={tasks.length} icon={Brain}        color="blue"  sub="All tasks" />
        <StatCard label="Running" value={running}       icon={Activity}     color="blue"  sub={running ? "Active" : "Idle"} />
        <StatCard label="Done"    value={completed}     icon={CheckCircle2} color="green" sub="Completed" />
        <StatCard label="Failed"  value={failed}        icon={XCircle}      color="red"   sub="Errors" />
      </div>

      <div className="bg-slate-900 border border-purple-800/30 rounded-2xl p-5 mb-5">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-gradient-to-br from-purple-600 to-blue-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-purple-600/20">
            <Cpu className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-white text-sm sm:text-base">Cerebras Wafer-Scale Engine</h3>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Running <span className="text-purple-300 font-mono font-bold">{MODEL_LABEL}</span> for AI reasoning.
              Vision falls back to <span className="text-blue-300">{FALLBACK_MODEL}</span>.
              CAPTCHA auto-solved via NopeCHA.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {["Ultra-fast inference", "Key rotation", "Auto CAPTCHA bypass", "Human-like browsing", "Session persistence"].map(f => (
                <span key={f} className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-full">{f}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3">Recent Tasks</h3>
      {tasks.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-slate-800 rounded-2xl">
          <Brain className="w-10 h-10 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-500">No tasks yet. Create one to get started.</p>
          <button onClick={onCreateTask} className="mt-4 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition touch-manipulation">
            Create Task
          </button>
        </div>
      ) : tasks.slice(0, 5).map(task => (
        <button key={task.id} onClick={() => onOpenTask(task)}
          className={`w-full flex items-center gap-3 sm:gap-4 p-3.5 sm:p-4 rounded-xl border mb-2 text-left hover:border-slate-700 transition cursor-pointer touch-manipulation ${statusBg(task.status)}`}>
          <StatusIcon status={task.status} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white truncate">{task.name}</p>
            <p className="text-xs text-slate-500 truncate">{task.prompt}</p>
          </div>
          <span className={`text-xs font-bold uppercase hidden sm:block flex-shrink-0 ${statusColor(task.status)}`}>{task.status}</span>
          <ChevronRight className="w-4 h-4 text-slate-600 flex-shrink-0" />
        </button>
      ))}
    </motion.div>
  );
}

// ─── Tasks Page ───────────────────────────────────────────────────────────────
function TasksPage({ tasks, onOpenTask, onRun, onDelete, onCreateTask }: {
  tasks: Task[]; onOpenTask: (t: Task) => void; onRun: (t: Task) => void;
  onDelete: (t: Task) => void; onCreateTask: () => void;
}) {
  return (
    <motion.div key="tasks" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-3">
      {tasks.length === 0 && (
        <div className="text-center py-16 border border-dashed border-slate-800 rounded-2xl">
          <Brain className="w-12 h-12 text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 font-semibold">No tasks yet</p>
          <p className="text-slate-600 text-sm mt-1">Create a task to deploy the agent</p>
          <button onClick={onCreateTask} className="mt-6 bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition touch-manipulation">
            Create First Task
          </button>
        </div>
      )}
      {tasks.map(task => (
        <div key={task.id} className={`p-4 sm:p-5 rounded-2xl border transition ${statusBg(task.status)}`}>
          <div className="flex items-start gap-3 sm:gap-4">
            <div className="mt-0.5"><StatusIcon status={task.status} /></div>
            <button className="flex-1 min-w-0 text-left" onClick={() => onOpenTask(task)}>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-bold text-white text-sm sm:text-base">{task.name}</p>
                <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full ${statusBadgeBg(task.status)}`}>{task.status}</span>
                {task.schedule && (
                  <span className="text-xs text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <Clock className="w-3 h-3" />{task.schedule}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-400 mt-1 line-clamp-2">{task.prompt}</p>
              {task.last_run && <p className="text-xs text-slate-600 mt-1">Last run: {timeAgo(task.last_run)}</p>}
              {task.result?.summary && (
                <p className="text-xs text-slate-500 mt-1.5 bg-slate-800/60 rounded-lg px-3 py-1.5 line-clamp-2">{task.result.summary}</p>
              )}
            </button>
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => onOpenTask(task)} title="Open chat"
                className="p-2 rounded-xl text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition touch-manipulation">
                <MessageSquare className="w-4 h-4" />
              </button>
              <button onClick={() => onRun(task)} disabled={task.status === "running" || task.status === "pending"} title="Run now"
                className="p-2 rounded-xl text-slate-500 hover:text-green-400 hover:bg-green-900/20 disabled:opacity-40 transition touch-manipulation">
                <Play className="w-4 h-4" />
              </button>
              <button onClick={() => onDelete(task)} title="Delete"
                className="p-2 rounded-xl text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition touch-manipulation">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </motion.div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { supabase, user, signOut } = useSupabase();
  const [nav, setNav]               = useState<NavId>("overview");
  const [tasks, setTasks]           = useState<Task[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadTasks = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase
      .from("tasks").select("*")
      .eq("user_id", user?.id)
      .order("created_at", { ascending: false });
    if (data) setTasks(data);
  }, [supabase, user?.id]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${user?.id}` }, () => {
        loadTasks();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, user?.id, loadTasks]);

  const refresh = async () => {
    setRefreshing(true);
    await loadTasks();
    setTimeout(() => setRefreshing(false), 600);
  };

  const runTask = async (task: Task) => {
    if (!supabase) return;
    await supabase.from("tasks").update({ status: "pending" }).eq("id", task.id);
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: "pending" } : t));
  };

  const deleteTask = async (task: Task) => {
    if (!supabase) return;
    if (!confirm(`Delete "${task.name}"?`)) return;
    await supabase.from("tasks").delete().eq("id", task.id);
    setTasks(prev => prev.filter(t => t.id !== task.id));
    if (selectedTask?.id === task.id) setSelectedTask(null);
  };

  const running = tasks.filter(t => t.status === "running").length;

  // Keep selectedTask in sync with tasks list
  const liveSelectedTask = selectedTask
    ? (tasks.find(t => t.id === selectedTask.id) || selectedTask)
    : null;

  return (
    <div className="flex h-screen bg-[#080d1a] overflow-hidden">

      {/* ── Desktop Sidebar ── */}
      <aside className="hidden lg:flex flex-col w-60 xl:w-64 bg-slate-950 border-r border-slate-800/60 flex-shrink-0">
        <div className="p-5 border-b border-slate-800/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-600/20 flex-shrink-0">
              <Brain className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="font-bold text-white text-sm leading-tight">AutoAgent Pro</p>
              <p className="text-xs text-slate-500">AI Browser Agent</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map(item => (
            <button key={item.id} onClick={() => { setNav(item.id); setSelectedTask(null); }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition touch-manipulation ${nav === item.id && !selectedTask ? "bg-blue-600/15 text-blue-400 border border-blue-600/20" : "text-slate-400 hover:text-white hover:bg-slate-800/60"}`}>
              <item.icon className="w-4 h-4 flex-shrink-0" />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-800/60 space-y-3">
          <div className="flex items-center gap-2 bg-purple-900/10 border border-purple-800/20 rounded-xl px-3 py-2">
            <Zap className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
            <span className="text-xs font-bold text-purple-300 truncate">{MODEL_SHORT}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-400 truncate flex-1">{user?.email}</p>
            <button onClick={signOut} className="text-xs text-slate-600 hover:text-red-400 transition px-2 py-1 rounded-lg hover:bg-red-900/10 flex-shrink-0">
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ── Mobile Drawer ── */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
            <motion.aside
              initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="fixed left-0 top-0 bottom-0 w-72 bg-slate-950 border-r border-slate-800/60 z-50 flex flex-col lg:hidden"
            >
              <div className="p-5 border-b border-slate-800/60 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center">
                    <Brain className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <p className="font-bold text-white text-sm">AutoAgent Pro</p>
                    <p className="text-xs text-slate-500">AI Browser Agent</p>
                  </div>
                </div>
                <button onClick={() => setMobileMenuOpen(false)} className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition touch-manipulation">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <nav className="flex-1 p-3 space-y-1">
                {NAV_ITEMS.map(item => (
                  <button key={item.id} onClick={() => { setNav(item.id); setSelectedTask(null); setMobileMenuOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm font-semibold transition touch-manipulation ${nav === item.id && !selectedTask ? "bg-blue-600/15 text-blue-400 border border-blue-600/20" : "text-slate-400 hover:text-white hover:bg-slate-800/60"}`}>
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    {item.label}
                  </button>
                ))}
              </nav>
              <div className="p-4 border-t border-slate-800/60 space-y-3">
                <div className="flex items-center gap-2 bg-purple-900/10 border border-purple-800/20 rounded-xl px-3 py-2">
                  <Zap className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                  <span className="text-xs font-bold text-purple-300 truncate">{MODEL_SHORT}</span>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-400 truncate flex-1 mr-2">{user?.email}</p>
                  <button onClick={signOut} className="text-xs text-slate-600 hover:text-red-400 transition px-2 py-1 rounded-lg hover:bg-red-900/10 flex-shrink-0">
                    Sign out
                  </button>
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* ── Main Content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">

        {/* Chat panel — slides over main content */}
        <AnimatePresence>
          {liveSelectedTask && (
            <motion.div
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
              className="absolute inset-0 z-30 bg-[#0a0f1e]"
            >
              <TaskChatPanel
                task={liveSelectedTask}
                onClose={() => setSelectedTask(null)}
                onRun={runTask}
                onDelete={deleteTask}
                supabase={supabase}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header */}
        <header className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-sm flex-shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition touch-manipulation">
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="font-bold text-white text-base sm:text-lg capitalize">{nav}</h1>
              {running > 0 && (
                <span className="flex items-center gap-1.5 text-xs text-blue-400">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  {running} running
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refresh} disabled={refreshing}
              className="p-2 rounded-xl text-slate-500 hover:text-white hover:bg-slate-800 transition touch-manipulation">
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
            {nav === "tasks" && (
              <button onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs sm:text-sm font-bold px-3 sm:px-4 py-2 rounded-xl transition shadow-lg shadow-blue-600/20 touch-manipulation">
                <PlusCircle className="w-4 h-4" />
                <span className="hidden sm:inline">New Task</span>
                <span className="sm:hidden">New</span>
              </button>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <AnimatePresence mode="wait">
            {nav === "overview" && (
              <OverviewPage
                tasks={tasks}
                onOpenTask={setSelectedTask}
                onCreateTask={() => { setNav("tasks"); setShowCreate(true); }}
              />
            )}
            {nav === "tasks" && (
              <TasksPage
                tasks={tasks}
                onOpenTask={setSelectedTask}
                onRun={runTask}
                onDelete={deleteTask}
                onCreateTask={() => setShowCreate(true)}
              />
            )}
            {nav === "settings" && (
              <motion.div key="settings" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <SettingsPage supabase={supabase} user={user} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Mobile Bottom Nav */}
        <nav className="lg:hidden flex items-stretch border-t border-slate-800/60 bg-slate-950/95 backdrop-blur-sm flex-shrink-0">
          {NAV_ITEMS.map(item => (
            <button key={item.id} onClick={() => { setNav(item.id); setSelectedTask(null); }}
              className={`flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-xs font-semibold transition touch-manipulation ${nav === item.id && !selectedTask ? "text-blue-400" : "text-slate-500"}`}>
              <item.icon className="w-5 h-5" />
              {item.label}
            </button>
          ))}
          <button onClick={() => setShowCreate(true)}
            className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5 text-xs font-semibold text-slate-500 touch-manipulation">
            <PlusCircle className="w-5 h-5" />
            Create
          </button>
        </nav>
      </div>

      {/* Create modal */}
      <AnimatePresence>
        {showCreate && (
          <CreateTaskModal
            onClose={() => setShowCreate(false)}
            onCreated={(t: Task) => { setTasks(p => [t, ...p]); setSelectedTask(t); }}
            supabase={supabase}
            user={user}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
