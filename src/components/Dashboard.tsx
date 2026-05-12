import { useState, useEffect, useRef, useCallback } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";
import { formatDate } from "@/lib/utils";

interface Task {
  id: string;
  name: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed" | "scheduled";
  last_run?: string;
  schedule?: string;
  result?: { summary?: string; success?: boolean; stepCount?: number };
  logs?: string;
  retry_count?: number;
  created_at: string;
}

interface TaskLog {
  id: string;
  task_id: string;
  message: string;
  log_type: "info" | "success" | "error" | "warning";
  created_at: string;
}

type Tab = "dashboard" | "tasks" | "settings" | "history";

const STATUS_CONFIG = {
  pending: { color: "text-amber-400", bg: "bg-amber-400/10 border-amber-500/20", dot: "bg-amber-400", label: "Pending" },
  running: { color: "text-blue-400", bg: "bg-blue-400/10 border-blue-500/20", dot: "bg-blue-400 animate-pulse", label: "Running" },
  completed: { color: "text-green-400", bg: "bg-green-400/10 border-green-500/20", dot: "bg-green-400", label: "Done" },
  failed: { color: "text-red-400", bg: "bg-red-400/10 border-red-500/20", dot: "bg-red-400", label: "Failed" },
  scheduled: { color: "text-purple-400", bg: "bg-purple-400/10 border-purple-500/20", dot: "bg-purple-400", label: "Scheduled" },
};

function StatusBadge({ status }: { status: Task["status"] }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${cfg.color} ${cfg.bg}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function SidebarLink({ active, onClick, icon, label, badge }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group ${
        active
          ? "bg-blue-600/20 text-blue-400 border border-blue-600/30"
          : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
      }`}
    >
      <span className={`${active ? "text-blue-400" : "text-slate-500 group-hover:text-slate-300"}`}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{badge}</span>
      )}
    </button>
  );
}

function StatCard({ label, value, sub, color = "text-white" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition-colors"
    >
      <p className="text-[11px] uppercase font-bold tracking-widest text-slate-500 mb-3">{label}</p>
      <p className={`text-3xl font-bold font-mono ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </motion.div>
  );
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { supabase, user } = useSupabase();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !name.trim() || !prompt.trim()) return;
    setLoading(true);
    setError("");
    const { error } = await supabase.from("tasks").insert({
      name: name.trim(),
      prompt: prompt.trim(),
      schedule: schedule.trim() || null,
      status: schedule.trim() ? "scheduled" : "pending",
      user_id: user?.id,
    });
    if (error) { setError(error.message); setLoading(false); return; }
    setLoading(false);
    onCreated();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl"
      >
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h2 className="text-lg font-bold text-white">Create New Task</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Task Name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              required
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
              placeholder="e.g. Daily Lead Scraper"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Task Prompt</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              required
              rows={4}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition resize-none"
              placeholder="Describe what the agent should do in detail. e.g. Go to linkedin.com, search for 'software engineer', and collect the first 10 profile URLs."
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-slate-500 mb-1.5">Cron Schedule (Optional)</label>
            <input
              value={schedule}
              onChange={e => setSchedule(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition font-mono"
              placeholder="e.g. 0 9 * * * (daily at 9am)"
            />
            <p className="text-xs text-slate-600 mt-1">Leave empty for manual execution</p>
          </div>
          {error && <p className="text-red-400 text-xs bg-red-900/20 border border-red-800/30 rounded-xl p-3">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-white text-sm font-semibold transition">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-bold transition"
            >
              {loading ? "Creating..." : "Create Task"}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function LogViewer({ task, onClose }: { task: Task; onClose: () => void }) {
  const { supabase } = useSupabase();
  const [logs, setLogs] = useState<TaskLog[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supabase) return;
    const fetchLogs = async () => {
      const { data } = await supabase
        .from("task_logs")
        .select("*")
        .eq("task_id", task.id)
        .order("created_at", { ascending: true });
      if (data) setLogs(data);
      setLoading(false);
    };
    fetchLogs();

    // Real-time subscription
    const sub = supabase
      .channel(`task-logs-${task.id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "task_logs",
        filter: `task_id=eq.${task.id}`,
      }, (payload) => {
        setLogs(prev => [...prev, payload.new as TaskLog]);
      })
      .subscribe();

    return () => { supabase.removeChannel(sub); };
  }, [supabase, task.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const logColors = {
    info: "text-slate-300",
    success: "text-green-400",
    error: "text-red-400",
    warning: "text-amber-400",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative bg-[#0a0a12] border border-slate-800 rounded-2xl w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between p-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            <span className="font-bold text-white font-mono text-sm">{task.name}</span>
            <StatusBadge status={task.status} />
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition p-1 rounded-lg hover:bg-slate-800">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1">
          {loading ? (
            <p className="text-slate-500 animate-pulse">Loading logs...</p>
          ) : logs.length === 0 ? (
            <p className="text-slate-600">No logs yet. Run the task to see output here.</p>
          ) : (
            logs.map(log => (
              <div key={log.id} className="flex gap-3">
                <span className="text-slate-600 shrink-0">{new Date(log.created_at).toLocaleTimeString()}</span>
                <span className={logColors[log.log_type] || "text-slate-300"}>{log.message}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
        {task.result && (
          <div className="p-4 border-t border-slate-800 bg-slate-900/50">
            <p className="text-xs text-slate-500">
              <span className="text-slate-400 font-semibold">Result:</span>{" "}
              {task.result.summary || "No summary available"}
            </p>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function SettingsTab() {
  const { supabase, user } = useSupabase();
  const [cerebrasKeys, setCerebrasKeys] = useState<string[]>([]);
  const [nopechaKey, setNopechaKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single().then(({ data }) => {
      if (data) {
        setCerebrasKeys(data.cerebras_keys || []);
        setNopechaKey(data.nopecha_key || "");
      }
    });
  }, [supabase, user]);

  const addKey = () => {
    if (newKey.trim()) {
      setCerebrasKeys(prev => [...prev, newKey.trim()]);
      setNewKey("");
    }
  };

  const removeKey = (i: number) => setCerebrasKeys(prev => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    if (!supabase || !user) return;
    setSaving(true);
    await supabase.from("settings").upsert({
      user_id: user.id,
      cerebras_keys: cerebrasKeys,
      nopecha_key: nopechaKey,
      updated_at: new Date().toISOString(),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">API Configuration</h2>
        <p className="text-sm text-slate-500">Manage your API keys for agent orchestration.</p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="text-sm font-bold text-white mb-1">Cerebras AI Keys</h3>
          <p className="text-xs text-slate-500 mb-4">Keys are rotated automatically for high-throughput tasks.</p>
          <div className="space-y-2">
            {cerebrasKeys.map((key, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-400">
                  {"•".repeat(20)}...{key.slice(-6)}
                </span>
                <button onClick={() => removeKey(i)} className="text-red-500 hover:text-red-400 p-2 rounded-lg hover:bg-red-900/20 transition">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
            <div className="flex gap-2 mt-3">
              <input
                value={newKey}
                onChange={e => setNewKey(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addKey()}
                type="password"
                className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
                placeholder="Add API key..."
              />
              <button onClick={addKey} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition">
                Add
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h3 className="text-sm font-bold text-white mb-1">NopeCHA CAPTCHA Solver</h3>
        <p className="text-xs text-slate-500 mb-4">Used for automatic CAPTCHA solving during agent tasks.</p>
        <input
          value={nopechaKey}
          onChange={e => setNopechaKey(e.target.value)}
          type="password"
          className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
          placeholder="nopecha_..."
        />
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition"
      >
        {saving ? "Saving..." : saved ? "Saved!" : "Save Settings"}
      </button>
    </motion.div>
  );
}

export default function Dashboard() {
  const { supabase, user, signOut } = useSupabase();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [runningTask, setRunningTask] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from("tasks").select("*").order("created_at", { ascending: false });
    if (data) setTasks(data);
  }, [supabase]);

  useEffect(() => {
    fetchTasks();
    // Real-time task updates
    if (!supabase) return;
    const sub = supabase
      .channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => fetchTasks())
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [supabase, fetchTasks]);

  const handleRunTask = async (task: Task) => {
    if (!supabase) return;
    setRunningTask(task.id);
    await supabase.from("tasks").update({ status: "pending" }).eq("id", task.id);
    // Trigger GitHub Actions dispatch
    try {
      await fetch(`https://api.github.com/repos/Joshbond123/AutoAgent/actions/workflows/agent-task.yml/dispatches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/vnd.github+json",
        },
        body: JSON.stringify({ ref: "main", inputs: { taskId: task.id } }),
      });
    } catch (_) {}
    fetchTasks();
    setRunningTask(null);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!supabase || !confirm("Delete this task?")) return;
    setDeleting(taskId);
    await supabase.from("tasks").delete().eq("id", taskId);
    fetchTasks();
    setDeleting(null);
  };

  const stats = {
    total: tasks.length,
    running: tasks.filter(t => t.status === "running").length,
    completed: tasks.filter(t => t.status === "completed").length,
    failed: tasks.filter(t => t.status === "failed").length,
    successRate: tasks.length > 0
      ? Math.round((tasks.filter(t => t.status === "completed").length / Math.max(tasks.filter(t => ["completed","failed"].includes(t.status)).length, 1)) * 100)
      : 0,
  };

  return (
    <div className="flex h-screen bg-[#0f172a] text-slate-200 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-slate-800 bg-[#020617] flex flex-col">
        <div className="flex items-center gap-3 px-5 py-6 border-b border-slate-800/50">
          <div className="w-8 h-8 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-600/30">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <p className="font-bold text-white text-sm leading-none">AutoAgent</p>
            <p className="text-[10px] text-blue-400 font-mono mt-0.5">PRO</p>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <SidebarLink active={activeTab === "dashboard"} onClick={() => setActiveTab("dashboard")} label="Dashboard"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" /></svg>}
          />
          <SidebarLink active={activeTab === "tasks"} onClick={() => setActiveTab("tasks")} label="All Tasks"
            badge={stats.running}
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>}
          />
          <SidebarLink active={activeTab === "history"} onClick={() => setActiveTab("history")} label="Run History"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
          />
          <SidebarLink active={activeTab === "settings"} onClick={() => setActiveTab("settings")} label="Settings"
            icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
          />
        </nav>

        <div className="p-3 border-t border-slate-800/50">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 mb-2">
            <div className="w-6 h-6 rounded-full bg-blue-600/30 flex items-center justify-center">
              <span className="text-blue-400 text-[10px] font-bold">{user?.email?.[0]?.toUpperCase() || "U"}</span>
            </div>
            <span className="text-xs text-slate-400 truncate flex-1">{user?.email?.split("@")[0]}</span>
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-slate-500 hover:text-red-400 hover:bg-red-900/10 transition text-xs font-medium"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-14 border-b border-slate-800 flex items-center justify-between px-6 shrink-0 bg-[#0f172a]">
          <div className="flex items-center gap-2">
            {stats.running > 0 && (
              <div className="flex items-center gap-2 px-3 py-1 bg-blue-600/10 border border-blue-600/30 rounded-full">
                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs font-medium text-blue-400">{stats.running} agent{stats.running > 1 ? "s" : ""} running</span>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-xl text-sm transition shadow-lg shadow-blue-600/20"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Task
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            {activeTab === "dashboard" && (
              <motion.div key="dash" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-6">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard label="Total Tasks" value={stats.total.toString()} sub="All time" />
                  <StatCard label="Running" value={stats.running.toString()} sub="Right now" color="text-blue-400" />
                  <StatCard label="Completed" value={stats.completed.toString()} sub="Successful" color="text-green-400" />
                  <StatCard label="Success Rate" value={`${stats.successRate}%`} sub="Completed vs failed" color="text-purple-400" />
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
                    <h3 className="text-sm font-bold text-white">Recent Tasks</h3>
                    <button onClick={() => setActiveTab("tasks")} className="text-xs text-blue-400 hover:text-blue-300 transition">View all</button>
                  </div>
                  {tasks.length === 0 ? (
                    <div className="p-12 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-3">
                        <svg className="w-6 h-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                      </div>
                      <p className="text-slate-500 text-sm">No tasks yet.</p>
                      <button onClick={() => setShowCreateModal(true)} className="mt-3 text-blue-400 hover:text-blue-300 text-sm font-semibold transition">
                        Create your first task
                      </button>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800">
                      {tasks.slice(0, 5).map(task => (
                        <div key={task.id} className="flex items-center gap-4 px-6 py-4 hover:bg-slate-800/30 transition">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{task.name}</p>
                            <p className="text-xs text-slate-500 truncate mt-0.5">{task.prompt}</p>
                          </div>
                          <StatusBadge status={task.status} />
                          <p className="text-xs text-slate-600 hidden md:block w-32 text-right">{formatDate(task.last_run || task.created_at)}</p>
                          <div className="flex gap-1">
                            <button onClick={() => setSelectedTask(task)} className="p-2 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleRunTask(task)}
                              disabled={task.status === "running" || runningTask === task.id}
                              className="p-2 rounded-lg text-slate-500 hover:text-green-400 hover:bg-green-900/20 transition disabled:opacity-40"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === "tasks" && (
              <motion.div key="tasks" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-bold text-white">All Tasks</h2>
                  <span className="text-xs text-slate-500 bg-slate-800 px-3 py-1 rounded-full">{tasks.length} total</span>
                </div>
                {tasks.length === 0 ? (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-12 text-center">
                    <p className="text-slate-500">No tasks created yet. Click "New Task" to get started.</p>
                  </div>
                ) : (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
                    <div className="divide-y divide-slate-800">
                      {tasks.map(task => (
                        <motion.div
                          key={task.id}
                          layout
                          className="flex items-center gap-4 px-6 py-4 hover:bg-slate-800/30 transition group"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-semibold text-white">{task.name}</p>
                              {task.schedule && (
                                <span className="text-[10px] font-mono text-purple-400 bg-purple-900/20 border border-purple-800/30 px-2 py-0.5 rounded-full">
                                  {task.schedule}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 truncate mt-0.5 max-w-md">{task.prompt}</p>
                          </div>
                          <StatusBadge status={task.status} />
                          <p className="text-xs text-slate-600 w-36 text-right hidden lg:block">{formatDate(task.last_run || task.created_at)}</p>
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                            <button onClick={() => setSelectedTask(task)} className="p-2 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 transition" title="View logs">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleRunTask(task)}
                              disabled={task.status === "running" || runningTask === task.id}
                              className="p-2 rounded-lg text-slate-500 hover:text-green-400 hover:bg-green-900/20 transition disabled:opacity-40"
                              title="Run now"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => handleDeleteTask(task.id)}
                              disabled={deleting === task.id}
                              className="p-2 rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition disabled:opacity-40"
                              title="Delete"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === "history" && (
              <motion.div key="history" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">
                <h2 className="text-xl font-bold text-white">Run History</h2>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl divide-y divide-slate-800 overflow-hidden">
                  {tasks.filter(t => t.status === "completed" || t.status === "failed").length === 0 ? (
                    <div className="p-12 text-center">
                      <p className="text-slate-500 text-sm">No completed runs yet.</p>
                    </div>
                  ) : (
                    tasks.filter(t => ["completed", "failed"].includes(t.status)).map(task => (
                      <div key={task.id} className="flex items-center gap-4 px-6 py-4">
                        <StatusBadge status={task.status} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-white">{task.name}</p>
                          {task.result?.summary && <p className="text-xs text-slate-500 truncate mt-0.5">{task.result.summary}</p>}
                        </div>
                        <p className="text-xs text-slate-600">{formatDate(task.last_run)}</p>
                        <button onClick={() => setSelectedTask(task)} className="text-xs text-blue-400 hover:text-blue-300 transition">View logs</button>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            )}

            {activeTab === "settings" && (
              <motion.div key="settings" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <SettingsTab />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Status bar */}
        <footer className="h-7 bg-[#020617] border-t border-slate-800 px-4 flex items-center justify-between shrink-0">
          <div className="flex gap-4 items-center">
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-600">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Supabase Connected
            </span>
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-slate-600">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              GitHub Actions Active
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-700">v2.0.0 · AutoAgent Pro</span>
        </footer>
      </div>

      {showCreateModal && (
        <CreateTaskModal onClose={() => setShowCreateModal(false)} onCreated={fetchTasks} />
      )}
      {selectedTask && (
        <LogViewer task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  );
}
