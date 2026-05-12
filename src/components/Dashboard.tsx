/**
 * AutoAgent Pro — Dashboard v5
 * Fixes: silent task creation failure (missing `name` col), auto-generated titles,
 * follow-up message input, settings race condition, realtime subscription cleanup,
 * error feedback, mobile responsive layout.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { motion, AnimatePresence } from "motion/react";
import SettingsPage from "./Settings";

interface Task {
  id: string;
  user_id: string;
  prompt: string;
  name?: string;
  status: "pending" | "running" | "completed" | "failed" | "stopped";
  created_at: string;
  updated_at: string;
  result?: string | { success: boolean; summary: string; stepCount: number; completedAt: string };
  last_run?: string;
}

interface TaskLog {
  id: string;
  task_id: string;
  message: string;
  log_type: "info" | "success" | "error" | "warning" | "screenshot" | "user";
  created_at: string;
}

interface SettingsData {
  cerebras_keys?: string[];
  nopecha_key?: string;
  cloudflare_account_id?: string;
  cloudflare_keys?: string[];
  cloudflare_model?: string;
  github_token?: string;
}

// ── Title generation ──────────────────────────────────────────────────────────
function generateTitle(prompt: string): string {
  const p = prompt.trim();
  const urlM = p.match(/(?:go to|visit|navigate to|open|browse)\s+((?:https?:\/\/)?[\w-]+\.(?:com|org|net|io|co|gov|edu|uk|app|dev|ai|gg|xyz|me)(?:\/\S*)?)/i);
  const domain = urlM ? urlM[1].replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] : null;

  const searchM  = p.match(/search(?:ing)?\s+for\s+["']?([^"',.\n]{3,40})["']?/i);
  const loginM   = p.match(/(?:log\s*in|login|sign\s*in|signin)\s+(?:to\s+|into\s+)?(.{3,30}?)(?:\s+and|\s+then|\.|,|$)/i);
  const extractM = p.match(/(?:extract|scrape|get|find|list|collect|grab)\s+(.{4,35}?)(?:\s+from|\s+on|\s+at|\.|,|$)/i);
  const buyM     = p.match(/(?:buy|purchase|order|add to cart)\s+(.{3,30}?)(?:\s+from|\s+on|\.|,|$)/i);
  const dlM      = p.match(/(?:download|save|export)\s+(.{3,30}?)(?:\s+from|\s+on|\.|,|$)/i);
  const fillM    = p.match(/(?:fill|complete|submit)\s+(.{4,35}?)(?:\s+form|\s+on|\.|,|$)/i);

  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const tr  = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "…" : s;

  if (loginM) return `Login: ${cap(loginM[1].trim())}`;
  if (buyM)   return `Purchase: ${cap(tr(buyM[1].trim(), 30))}`;
  if (dlM)    return `Download: ${cap(tr(dlM[1].trim(), 30))}`;
  if (fillM)  return `Form: ${cap(tr(fillM[1].trim(), 30))}`;
  if (searchM && domain) return `Search "${tr(searchM[1].trim(), 22)}" on ${domain}`;
  if (searchM)  return `Search: ${tr(searchM[1].trim(), 38)}`;
  if (extractM && domain) return `Extract from ${domain}`;
  if (extractM) return `Extract: ${cap(tr(extractM[1].trim(), 30))}`;
  if (domain)   return `Browse ${domain}`;
  const first = p.split(/[.!?\n]/)[0].trim();
  return tr(cap(first), 50);
}

// ── Meta ──────────────────────────────────────────────────────────────────────
const STATUS_META = {
  pending:   { color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", dot: "bg-yellow-400", pulse: true,  label: "Pending"   },
  running:   { color: "text-blue-400",   bg: "bg-blue-500/10 border-blue-500/20",     dot: "bg-blue-400",   pulse: true,  label: "Running"   },
  completed: { color: "text-green-400",  bg: "bg-green-500/10 border-green-500/20",   dot: "bg-green-400",  pulse: false, label: "Completed" },
  failed:    { color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20",       dot: "bg-red-400",    pulse: false, label: "Failed"    },
  stopped:   { color: "text-slate-400",  bg: "bg-slate-500/10 border-slate-500/20",   dot: "bg-slate-400",  pulse: false, label: "Stopped"   },
} as const;

const LOG_META: Record<string, { icon: string; cls: string }> = {
  info:       { icon: "→",  cls: "text-slate-300"  },
  success:    { icon: "✓",  cls: "text-green-400"  },
  error:      { icon: "✗",  cls: "text-red-400"    },
  warning:    { icon: "⚠",  cls: "text-yellow-400" },
  screenshot: { icon: "📸", cls: "text-purple-400" },
  user:       { icon: "💬", cls: "text-blue-300"   },
};

function timeAgo(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function getResultText(task: Task): string {
  if (!task.result) return "";
  if (typeof task.result === "string") {
    try { const p = JSON.parse(task.result); return p.summary || task.result; } catch { return task.result; }
  }
  return task.result.summary || "";
}

function hasAIKeys(s: SettingsData | null): boolean {
  if (!s) return false;
  return (
    (Array.isArray(s.cerebras_keys) && s.cerebras_keys.length > 0) ||
    (Array.isArray(s.cloudflare_keys) && s.cloudflare_keys.length > 0 && !!s.cloudflare_account_id)
  );
}

// ── StatusBadge ───────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: Task["status"] }) {
  const m = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border flex-shrink-0 ${m.bg} ${m.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot} ${m.pulse ? "animate-pulse" : ""}`} />
      {m.label}
    </span>
  );
}

// ── TypingDots ────────────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 ml-1">
      {[0, 1, 2].map(i => (
        <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block"
          animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.2 }} />
      ))}
    </span>
  );
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const imgSrc = src.startsWith("data:") ? src : `data:image/jpeg;base64,${src}`;
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}>
      <motion.div initial={{ scale: 0.85 }} animate={{ scale: 1 }}
        className="relative max-w-5xl max-h-full" onClick={e => e.stopPropagation()}>
        <img src={imgSrc} className="max-w-full max-h-[85vh] rounded-xl shadow-2xl object-contain" alt="Screenshot" />
        <button onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-slate-800 border border-slate-600 text-white hover:bg-slate-700 flex items-center justify-center text-sm shadow-lg">
          ✕
        </button>
      </motion.div>
    </motion.div>
  );
}

// ── TaskChatPanel ─────────────────────────────────────────────────────────────
function TaskChatPanel({
  task, logs, settings,
  onStop, onRerun, onDelete, onRunNow, runNowLoading, onSendMessage,
}: {
  task: Task; logs: TaskLog[]; settings: SettingsData | null;
  onStop: () => void; onRerun: () => void; onDelete: () => void;
  onRunNow: () => void; runNowLoading: boolean;
  onSendMessage: (msg: string) => Promise<void>;
}) {
  const scrollRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom]     = useState(true);
  const [lightbox, setLightbox]     = useState<string | null>(null);
  const [msgDraft, setMsgDraft]     = useState("");
  const [sendingMsg, setSendingMsg] = useState(false);

  const isLive     = task.status === "running" || task.status === "pending";
  const nonSS      = logs.filter(l => l.log_type !== "screenshot");
  const screenshots = logs.filter(l => l.log_type === "screenshot");
  const latestSS   = screenshots[screenshots.length - 1];
  const stepCount  = nonSS.filter(l => l.log_type !== "user").length;
  const pct        = Math.min(100, Math.max(3, (stepCount / 30) * 100));
  const title      = task.name || generateTitle(task.prompt);
  const aiReady    = hasAIKeys(settings);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, []);

  useEffect(() => { if (atBottom) scrollToBottom(); }, [logs.length, atBottom, scrollToBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  async function sendMessage() {
    const msg = msgDraft.trim();
    if (!msg || sendingMsg) return;
    setSendingMsg(true);
    setMsgDraft("");
    await onSendMessage(msg);
    setSendingMsg(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  return (
    <div className="flex flex-col h-full bg-slate-950 relative">

      {/* ── Header ── */}
      <div className="flex-shrink-0 px-4 py-3 bg-slate-900/80 backdrop-blur border-b border-slate-800">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <StatusBadge status={task.status} />
              <span className="text-[11px] text-slate-500">{timeAgo(task.created_at)}</span>
              {stepCount > 0 && <span className="text-[11px] text-slate-500">{stepCount} steps</span>}
            </div>
            <p className="text-sm font-bold text-white leading-snug">{title}</p>
            <p className="text-xs text-slate-500 mt-0.5 line-clamp-1 leading-snug">{task.prompt}</p>
          </div>
          <div className="flex flex-col gap-1 flex-shrink-0">
            {isLive ? (
              <button onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-bold transition">
                <span className="w-2 h-2 bg-red-400 rounded-sm inline-block" /> Stop
              </button>
            ) : (
              <button onClick={onRerun}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 text-xs font-bold transition">
                ↺ Re-run
              </button>
            )}
            <button onClick={onDelete}
              className="px-3 py-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 text-xs font-semibold transition">
              Delete
            </button>
          </div>
        </div>
        {isLive && (
          <div className="mt-2">
            <div className="h-0.5 bg-slate-800 rounded-full overflow-hidden">
              <motion.div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full"
                animate={{ width: `${pct}%` }} transition={{ duration: 0.5 }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Live screenshot strip ── */}
      <AnimatePresence>
        {latestSS && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            className="flex-shrink-0 bg-slate-900/40 border-b border-slate-800/60 px-3 py-1.5 flex items-center gap-2">
            <span className="text-[10px] text-slate-500 uppercase tracking-widest flex-shrink-0">Live view</span>
            <button onClick={() => setLightbox(latestSS.message)}
              className="relative h-12 flex-1 overflow-hidden rounded-lg border border-slate-700 hover:border-blue-500/50 transition group">
              <img
                src={latestSS.message.startsWith("data:") ? latestSS.message : `data:image/jpeg;base64,${latestSS.message}`}
                className="w-full h-full object-cover object-top" alt="Live" />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center">
                <span className="text-white text-[10px] font-bold opacity-0 group-hover:opacity-100 transition">EXPAND</span>
              </div>
            </button>
            {screenshots.length > 1 && (
              <span className="text-[10px] text-slate-500 flex-shrink-0">{screenshots.length} frames</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={onScroll}>
        <div className="p-4 space-y-4 pb-2">

          {/* User initial prompt */}
          <div className="flex justify-end">
            <div className="max-w-[82%] bg-blue-600 rounded-2xl rounded-br-sm px-4 py-3 shadow-lg shadow-blue-600/20">
              <p className="text-sm text-white leading-relaxed">{task.prompt}</p>
              <p className="text-[10px] text-blue-200 mt-1.5 text-right">{new Date(task.created_at).toLocaleTimeString()}</p>
            </div>
          </div>

          {/* Setup warning */}
          {!aiReady && task.status === "pending" && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl px-4 py-3.5 bg-amber-500/8 border border-amber-500/25 text-amber-300 text-sm">
              <p className="font-bold mb-1">⚠️ AI Keys Required</p>
              <p className="text-xs text-amber-200/80 leading-relaxed">
                Go to <strong>Settings → Cerebras AI</strong> or <strong>Cloudflare AI</strong> and add at least one API key, then re-run this task.
              </p>
            </motion.div>
          )}

          {/* Agent log block */}
          {(nonSS.length > 0 || isLive) && (
            <div className="flex items-start gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center flex-shrink-0 mt-0.5 shadow-lg">
                <span className="text-white font-black text-[10px]">A</span>
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <p className="text-[11px] text-slate-500 font-semibold">
                  AutoAgent Pro
                  <span className="ml-2 text-slate-600 font-normal">☁️ Cloudflare kimi-k2.6 · ⚡ Cerebras</span>
                </p>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl rounded-tl-sm overflow-hidden">
                  {nonSS.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-slate-400 flex items-center gap-2">
                      Initializing browser agent<TypingDots />
                    </div>
                  ) : nonSS.map((log, i) => {
                    const m = LOG_META[log.log_type] || LOG_META.info;
                    const isLatest = isLive && i === nonSS.length - 1;

                    if (log.log_type === "user") {
                      return (
                        <div key={log.id}
                          className="flex items-start gap-2 px-4 py-2.5 border-b border-slate-800/50 last:border-0 bg-blue-500/5">
                          <span className="text-xs mt-0.5 flex-shrink-0 text-blue-400">💬</span>
                          <span className="text-sm text-blue-300 flex-1 leading-relaxed italic">{log.message}</span>
                          <span className="text-[10px] text-slate-600 flex-shrink-0 mt-0.5">
                            {new Date(log.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      );
                    }

                    return (
                      <motion.div key={log.id}
                        initial={isLatest ? { opacity: 0, y: 4 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex items-start gap-2.5 px-4 py-2 border-b border-slate-800/50 last:border-0 ${
                          log.log_type === "success" ? "bg-green-500/5" :
                          log.log_type === "error"   ? "bg-red-500/5" : ""
                        }`}>
                        <span className={`text-xs mt-0.5 flex-shrink-0 ${m.cls}`}>{m.icon}</span>
                        <span className={`text-sm flex-1 leading-relaxed ${m.cls}`}>{log.message}</span>
                        <span className="text-[10px] text-slate-600 flex-shrink-0 mt-0.5">
                          {new Date(log.created_at).toLocaleTimeString()}
                        </span>
                      </motion.div>
                    );
                  })}
                  {isLive && nonSS.length > 0 && (
                    <div className="px-4 py-2.5 text-sm text-slate-400 flex items-center gap-1 border-t border-slate-800/50">
                      Processing<TypingDots />
                    </div>
                  )}
                </div>

                {/* Screenshot gallery */}
                {screenshots.length > 1 && (
                  <div>
                    <p className="text-[11px] text-slate-500 mb-1.5">{screenshots.length} screenshots captured</p>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                      {screenshots.map((s, i) => (
                        <button key={s.id} onClick={() => setLightbox(s.message)}
                          className="relative aspect-video rounded-lg overflow-hidden border border-slate-700 hover:border-blue-500/50 group transition">
                          <img
                            src={s.message.startsWith("data:") ? s.message : `data:image/jpeg;base64,${s.message}`}
                            className="w-full h-full object-cover object-top" alt={`#${i + 1}`} />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition flex items-center justify-center">
                            <span className="text-white text-[10px] font-bold opacity-0 group-hover:opacity-100">#{i + 1}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Result */}
          {(task.status === "completed" || task.status === "failed") && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={`rounded-2xl px-4 py-3.5 border text-sm ${
                task.status === "completed"
                  ? "bg-green-500/5 border-green-500/20 text-green-300"
                  : "bg-red-500/5 border-red-500/20 text-red-300"
              }`}>
              <p className="font-bold text-[11px] uppercase tracking-widest mb-1.5">
                {task.status === "completed" ? "✓ Completed successfully" : "✗ Task failed"}
              </p>
              <p className="leading-relaxed whitespace-pre-wrap text-sm">{getResultText(task)}</p>
            </motion.div>
          )}

          {/* Pending CTA */}
          {task.status === "pending" && aiReady && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className="flex flex-col items-center py-8 gap-4">
              <div className="w-12 h-12 rounded-2xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-yellow-400">Queued for execution</p>
                {settings?.github_token ? (
                  <p className="text-xs text-slate-500 mt-1">Workflow dispatched — browser agent starting shortly…</p>
                ) : (
                  <p className="text-xs text-slate-500 mt-1 max-w-xs">
                    Waiting for GitHub Actions schedule (~10 min). Add a GitHub PAT in Settings for instant execution.
                  </p>
                )}
              </div>
              {!settings?.github_token && (
                <button onClick={onRunNow} disabled={runNowLoading}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-6 py-2.5 rounded-xl text-sm font-bold transition shadow-lg shadow-blue-600/20">
                  {runNowLoading
                    ? <><div className="w-3.5 h-3.5 border-2 border-white/50 border-t-white rounded-full animate-spin" /> Dispatching…</>
                    : <>⚡ Run Now via GitHub</>
                  }
                </button>
              )}
            </motion.div>
          )}
        </div>
      </div>

      {/* Jump to bottom */}
      <AnimatePresence>
        {!atBottom && (
          <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            onClick={scrollToBottom}
            className="absolute bottom-[72px] left-1/2 -translate-x-1/2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 px-4 py-1.5 rounded-full text-xs font-semibold shadow-xl transition z-10">
            ↓ Latest
          </motion.button>
        )}
      </AnimatePresence>

      {/* Message input */}
      <div className="flex-shrink-0 border-t border-slate-800 bg-slate-900/80 backdrop-blur px-3 py-2.5">
        <div className="flex items-end gap-2">
          <div className="flex-1 bg-slate-800 rounded-2xl border border-slate-700 focus-within:border-blue-500/50 transition overflow-hidden">
            <textarea
              ref={inputRef}
              value={msgDraft}
              onChange={e => setMsgDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              }}
              placeholder={
                isLive
                  ? "Send an instruction to the running agent…"
                  : "Ask a follow-up or run with a new instruction…"
              }
              rows={1}
              className="w-full bg-transparent px-4 py-2.5 text-sm text-white placeholder-slate-500 resize-none focus:outline-none leading-relaxed"
              style={{ maxHeight: "120px", overflowY: "auto" }}
            />
          </div>
          <button onClick={sendMessage} disabled={!msgDraft.trim() || sendingMsg}
            className="flex-shrink-0 w-10 h-10 rounded-2xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white flex items-center justify-center transition shadow-md shadow-blue-600/20">
            {sendingMsg
              ? <div className="w-4 h-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
              : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
            }
          </button>
        </div>
        <p className="text-[10px] text-slate-600 mt-1 px-1">Enter to send · Shift+Enter for new line</p>
      </div>

      <AnimatePresence>
        {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </AnimatePresence>
    </div>
  );
}

// ── NewTaskForm ───────────────────────────────────────────────────────────────
function NewTaskForm({
  onCreate, creating, error, settings, onOpenSettings,
}: {
  onCreate: (p: string) => void; creating: boolean;
  error: string; settings: SettingsData | null;
  onOpenSettings: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const aiReady = hasAIKeys(settings);

  const EXAMPLES = [
    "Go to google.com, search for 'latest AI news 2025', and list the top 5 headlines",
    "Visit news.ycombinator.com and list the top 10 story titles with their scores",
    "Go to github.com/trending and extract the top 5 repos with star counts and descriptions",
    "Navigate to en.wikipedia.org, search for 'Large language model', and summarize the intro",
  ];

  function submit() {
    if (!prompt.trim() || creating) return;
    onCreate(prompt.trim());
    setPrompt("");
  }

  return (
    <div className="h-full flex flex-col items-center justify-center p-6 overflow-y-auto">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-2xl space-y-5">

        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center mx-auto mb-4 shadow-xl shadow-blue-600/30">
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">AutoAgent Pro</h1>
          <p className="text-sm text-slate-400 mt-1">Autonomous browser agent · Cerebras AI + Cloudflare Vision</p>
        </div>

        {/* Setup required banner */}
        {settings !== null && !aiReady && (
          <div className="bg-amber-500/8 border border-amber-500/25 rounded-2xl px-4 py-4">
            <p className="text-sm font-bold text-amber-300 mb-1.5">⚠️ Setup required</p>
            <p className="text-xs text-amber-200/70 leading-relaxed mb-3">
              Add at least one <strong>Cerebras AI</strong> or <strong>Cloudflare AI</strong> API key so the browser agent can make decisions.
            </p>
            <button onClick={onOpenSettings}
              className="text-xs font-bold text-amber-300 border border-amber-500/30 rounded-lg px-3 py-1.5 hover:bg-amber-500/10 transition">
              Open Settings →
            </button>
          </div>
        )}

        {/* Error feedback */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-red-500/10 border border-red-500/25 rounded-2xl px-4 py-3 text-sm text-red-300">
              <span className="font-bold">Error: </span>{error}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Input */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl focus-within:border-slate-700 transition">
          <textarea
            ref={ref}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
            placeholder={"Describe what you want the agent to do…\ne.g. Go to amazon.com, search for 'wireless keyboard', extract the top 5 results with prices"}
            rows={4}
            className="w-full bg-transparent text-sm text-white placeholder-slate-600 resize-none focus:outline-none leading-relaxed"
          />
          {prompt.trim() && (
            <p className="text-[11px] text-slate-500 mt-1 mb-2">
              Title: <span className="text-slate-400 font-semibold">{generateTitle(prompt)}</span>
            </p>
          )}
          <div className="flex items-center justify-between pt-3 mt-1 border-t border-slate-800">
            <span className="text-[11px] text-slate-600 hidden sm:block">⌘+Enter to send</span>
            <button disabled={!prompt.trim() || creating}
              onClick={submit}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-5 py-2 rounded-xl text-sm font-bold transition shadow-md shadow-blue-600/20">
              {creating
                ? <><div className="w-3.5 h-3.5 border-2 border-white/50 border-t-white rounded-full animate-spin" /> Creating…</>
                : <>▶ Run Task</>
              }
            </button>
          </div>
        </div>

        {/* Examples */}
        <div>
          <p className="text-[11px] text-slate-600 uppercase tracking-widest mb-2 font-bold">Try an example</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {EXAMPLES.map((ex, i) => (
              <button key={i} onClick={() => { setPrompt(ex); ref.current?.focus(); }}
                className="text-left text-xs text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2.5 transition leading-relaxed">
                {ex}
              </button>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { supabase, user, signOut } = useSupabase();

  const [tasks,         setTasks]         = useState<Task[]>([]);
  const [taskLogs,      setTaskLogs]      = useState<Record<string, TaskLog[]>>({});
  const [activeId,      setActiveId]      = useState<string | null>(null);
  const [view,          setView]          = useState<"tasks" | "settings">("tasks");
  const [settings,      setSettings]      = useState<SettingsData | null>(null);
  const [runNowLoading, setRunNowLoading] = useState<string | null>(null);
  const [sidebarOpen,   setSidebarOpen]   = useState(true);
  const [creating,      setCreating]      = useState(false);
  const [createError,   setCreateError]   = useState("");

  const activeTask = tasks.find(t => t.id === activeId) ?? null;
  const logs       = activeId ? (taskLogs[activeId] ?? []) : [];

  // Load settings
  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single()
      .then(({ data }) => { setSettings(data ? (data as SettingsData) : {}); });
  }, [supabase, user]);

  // Load tasks + realtime
  useEffect(() => {
    if (!supabase || !user) return;
    supabase.from("tasks").select("*").eq("user_id", user.id).order("created_at", { ascending: false })
      .then(({ data }) => { if (data) setTasks(data as Task[]); });

    const ch = supabase.channel(`tasks-${user.id}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${user.id}` },
        ({ eventType, new: n, old: o }) => {
          setTasks(prev =>
            eventType === "INSERT" ? [n as Task, ...prev]
              : eventType === "UPDATE" ? prev.map(t => t.id === (n as Task).id ? n as Task : t)
              : prev.filter(t => t.id !== (o as Task).id)
          );
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, user]);

  // Load + subscribe to logs — re-fetch every time activeId changes
  useEffect(() => {
    if (!supabase || !activeId) return;

    supabase.from("task_logs").select("*").eq("task_id", activeId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (data) setTaskLogs(p => ({ ...p, [activeId]: data as TaskLog[] }));
      });

    const ch = supabase.channel(`logs-${activeId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "task_logs", filter: `task_id=eq.${activeId}` },
        ({ new: n }) => {
          setTaskLogs(p => ({ ...p, [activeId]: [...(p[activeId] ?? []), n as TaskLog] }));
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, activeId]);

  // ── Task actions ──────────────────────────────────────────────────────────

  const createTask = async (prompt: string) => {
    if (!supabase || !user || creating) return;
    setCreating(true);
    setCreateError("");

    const name = generateTitle(prompt);

    const { data, error } = await supabase.from("tasks").insert({
      user_id:    user.id,
      prompt,
      name,
      status:     "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();

    setCreating(false);

    if (error) {
      console.error("[createTask] Error:", error);
      setCreateError(error.message || "Task creation failed. Check your Supabase connection.");
      return;
    }

    if (data) {
      setActiveId(data.id);
      setView("tasks");
      const token = settings?.github_token;
      if (token) triggerWorkflow(data.id, token);
    }
  };

  const triggerWorkflow = async (taskId: string, token: string) => {
    setRunNowLoading(taskId);
    try {
      const r = await fetch(
        "https://api.github.com/repos/Joshbond123/AutoAgent/actions/workflows/agent-task.yml/dispatches",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
          body: JSON.stringify({ ref: "main", inputs: { task_id: taskId } }),
        }
      );
      const msg = (r.ok || r.status === 204)
        ? "⚡ GitHub Actions workflow dispatched — browser agent starting…"
        : `⚠️ Dispatch returned ${r.status} — check your GitHub PAT in Settings`;
      await supabase?.from("task_logs").insert({
        task_id:    taskId,
        message:    msg,
        log_type:   r.ok || r.status === 204 ? "info" : "warning",
        created_at: new Date().toISOString(),
      });
    } catch (e) {
      console.error("[triggerWorkflow]", e);
    }
    setRunNowLoading(null);
  };

  const stopTask = (id: string) =>
    supabase?.from("tasks").update({ status: "stopped", updated_at: new Date().toISOString() }).eq("id", id);

  const deleteTask = async (id: string) => {
    await supabase?.from("task_logs").delete().eq("task_id", id);
    await supabase?.from("tasks").delete().eq("id", id);
    setTaskLogs(p => { const n = { ...p }; delete n[id]; return n; });
    const rest = tasks.filter(t => t.id !== id);
    setActiveId(rest[0]?.id ?? null);
  };

  const rerunTask = async (task: Task) => {
    if (!supabase || !user) return;
    setCreating(true);
    const { data } = await supabase.from("tasks").insert({
      user_id:    user.id,
      prompt:     task.prompt,
      name:       task.name || generateTitle(task.prompt),
      status:     "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();
    setCreating(false);
    if (data) {
      setActiveId(data.id);
      const token = settings?.github_token;
      if (token) triggerWorkflow(data.id, token);
    }
  };

  const sendMessage = async (msg: string) => {
    if (!supabase || !activeId) return;
    await supabase.from("task_logs").insert({
      task_id:    activeId,
      message:    msg,
      log_type:   "user",
      created_at: new Date().toISOString(),
    });
    // If task is done, create a follow-up task
    const t = tasks.find(x => x.id === activeId);
    if (t && (t.status === "completed" || t.status === "failed" || t.status === "stopped")) {
      await createTask(`${t.prompt}\n\nFOLLOW-UP INSTRUCTION: ${msg}`);
    }
  };

  const reloadSettings = () => {
    if (!supabase || !user) return;
    supabase.from("settings").select("*").eq("user_id", user.id).single()
      .then(({ data }) => { if (data) setSettings(data as SettingsData); });
  };

  // ── Counts ────────────────────────────────────────────────────────────────
  const pendingN = tasks.filter(t => t.status === "pending").length;
  const runningN = tasks.filter(t => t.status === "running").length;

  return (
    <div className="flex h-full bg-slate-950 overflow-hidden">

      {/* Sidebar */}
      <AnimatePresence initial={false}>
        {sidebarOpen && (
          <motion.aside key="sb"
            initial={{ width: 0, opacity: 0 }} animate={{ width: 260, opacity: 1 }} exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="flex-shrink-0 flex flex-col border-r border-slate-800 bg-slate-900 overflow-hidden z-10">

            {/* Brand */}
            <div className="px-4 py-3.5 border-b border-slate-800 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-lg flex-shrink-0">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white leading-none">AutoAgent Pro</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">AI Browser Agent</p>
                </div>
              </div>
              {(pendingN + runningN) > 0 && (
                <div className="mt-2 flex gap-3 text-[11px]">
                  {runningN > 0 && <span className="text-blue-400 flex items-center gap-1"><span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />{runningN} running</span>}
                  {pendingN > 0 && <span className="text-yellow-400 flex items-center gap-1"><span className="w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" />{pendingN} pending</span>}
                </div>
              )}
            </div>

            {/* New task */}
            <div className="px-3 py-2.5 border-b border-slate-800 flex-shrink-0">
              <button onClick={() => { setActiveId(null); setView("tasks"); setCreateError(""); }}
                className="w-full flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2.5 rounded-xl text-sm font-bold transition shadow-md shadow-blue-600/20">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                New Task
              </button>
            </div>

            {/* Task list */}
            <div className="flex-1 overflow-y-auto py-1">
              {tasks.length === 0 ? (
                <p className="text-xs text-slate-600 text-center py-8 px-4">No tasks yet. Create your first one!</p>
              ) : tasks.map(t => {
                const m = STATUS_META[t.status];
                const isActive = activeId === t.id;
                const ttl = t.name || generateTitle(t.prompt);
                return (
                  <button key={t.id} onClick={() => { setActiveId(t.id); setView("tasks"); }}
                    className={`w-full text-left px-3 py-2.5 mx-0.5 transition rounded-xl my-0.5 ${isActive ? "bg-slate-800" : "hover:bg-slate-800/50"}`}
                    style={{ width: "calc(100% - 4px)" }}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot} ${m.pulse ? "animate-pulse" : ""}`} />
                      <span className={`text-[10px] font-bold uppercase tracking-wide ${m.color}`}>{m.label}</span>
                      <span className="text-[10px] text-slate-600 ml-auto">{timeAgo(t.created_at)}</span>
                    </div>
                    <p className="text-[12px] text-slate-200 font-semibold leading-snug pl-3 truncate">{ttl}</p>
                    <p className="text-[11px] text-slate-500 leading-snug pl-3 line-clamp-1 mt-0.5">{t.prompt}</p>
                  </button>
                );
              })}
            </div>

            {/* Footer */}
            <div className="border-t border-slate-800 p-3 flex-shrink-0 space-y-1">
              <button onClick={() => setView("settings")}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition ${view === "settings" ? "bg-slate-800 text-white font-bold" : "text-slate-400 hover:text-white hover:bg-slate-800/50"}`}>
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Settings
              </button>
              <button onClick={signOut}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                <span className="truncate">Sign out · {user?.email}</span>
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Toggle sidebar */}
      <button onClick={() => setSidebarOpen(o => !o)}
        className="absolute top-3 left-3 z-20 w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700/60 text-slate-400 hover:text-white flex items-center justify-center transition shadow-lg">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d={sidebarOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"} />
        </svg>
      </button>

      {/* Main */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {view === "settings" ? (
          <div className="flex-1 overflow-y-auto">
            <div className="pt-14 px-4 sm:px-6 pb-8 max-w-3xl mx-auto">
              <SettingsPage onSettingsSaved={reloadSettings} />
            </div>
          </div>
        ) : activeTask ? (
          <div className="flex-1 overflow-hidden">
            <TaskChatPanel
              task={activeTask}
              logs={logs}
              settings={settings}
              onStop={() => stopTask(activeTask.id)}
              onRerun={() => rerunTask(activeTask)}
              onDelete={() => deleteTask(activeTask.id)}
              onRunNow={() => { const t = settings?.github_token; if (t) triggerWorkflow(activeTask.id, t); }}
              runNowLoading={runNowLoading === activeTask.id}
              onSendMessage={sendMessage}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden pt-10">
            <NewTaskForm
              onCreate={createTask}
              creating={creating}
              error={createError}
              settings={settings}
              onOpenSettings={() => setView("settings")}
            />
          </div>
        )}
      </div>
    </div>
  );
}
