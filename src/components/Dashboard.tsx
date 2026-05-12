import { useState, useEffect } from "react";
import { useSupabase } from "@/src/contexts/SupabaseContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, Trash2, Eye, LayoutDashboard, Settings as SettingsIcon, History, Terminal } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { io, Socket } from "socket.io-client";

interface Task {
  id: string;
  name: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  last_run?: string;
  schedule?: string;
}

export default function Dashboard() {
  const { supabase, user } = useSupabase();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [logs, setLogs] = useState<{ message: string; type: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'tasks' | 'settings'>('dashboard');
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    const s = io();
    setSocket(s);
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [supabase]);

  const fetchTasks = async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (data) setTasks(data);
  };

  const handleRunTask = async (taskId: string) => {
    await fetch(`/api/tasks/${taskId}/execute`, { method: 'POST' });
    fetchTasks();
  };

  const openLogViewer = (task: Task) => {
    setSelectedTask(task);
    setLogs([]);
    if (socket) {
      socket.emit("subscribe:task", task.id);
      socket.on("log", (log: { message: string; type: string }) => {
        setLogs(prev => [...prev.slice(-49), log]);
      });
    }
  };

  const closeLogViewer = () => {
    if (socket && selectedTask) {
      socket.emit("unsubscribe:task", selectedTask.id);
      socket.off("log");
    }
    setSelectedTask(null);
  };

  return (
    <div className="flex h-screen bg-[#0f172a] text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-[#020617] flex flex-col pt-6">
        <div className="flex items-center space-x-3 px-6 mb-8">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-600/20">
             <LayoutDashboard className="text-white w-5 h-5" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">AutoAgent</span>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <SidebarLink active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} icon={<LayoutDashboard size={18} />} label="Dashboard" />
          <SidebarLink active={activeTab === 'tasks'} onClick={() => setActiveTab('tasks')} icon={<History size={18} />} label="Tasks" />
          <SidebarLink active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<SettingsIcon size={18} />} label="API Keys" />
        </nav>

        <div className="p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-3">
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Cerebras Status</span>
              <span className="flex h-2 w-2 rounded-full bg-green-500 shadow-sm shadow-green-500/50 animate-pulse"></span>
            </div>
            <p className="text-xs text-slate-300 font-mono">4 Active Keys</p>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Header */}
        <header className="h-16 border-b border-slate-800 bg-[#0f172a] flex items-center justify-between px-8 shrink-0">
          <div>
            <h1 className="text-lg font-semibold text-white">Live Agent Dashboard</h1>
            <p className="text-xs text-slate-400">Monitor and manage your autonomous browser workers</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-full">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
              <span className="text-xs font-medium">{tasks.filter(t => t.status === 'running').length} Active Agents</span>
            </div>
            <Button className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-4 py-2 h-9 rounded-md transition-colors border-none">
              + Create New Task
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          <AnimatePresence mode="wait">
            {activeTab === 'dashboard' ? (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                {/* Stats Grid */}
                <div className="grid grid-cols-3 gap-6">
                  <StatCard label="Total Executions" value={tasks.length.toString()} trend="+12.4%" />
                  <StatCard label="Success Rate" value="98.4%" trend="Stable" />
                  <StatCard label="API Cost (Est.)" value="$0.42" trend="Daily" color="text-blue-500" />
                </div>

                {/* Task Grid Area */}
                <div className="grid grid-cols-12 gap-6">
                  <div className="col-span-12 xl:col-span-8">
                    <Card className="bg-slate-900 border-slate-800 overflow-hidden shadow-2xl">
                      <CardHeader className="border-b border-slate-800 bg-[#0c0c0c] flex flex-row items-center justify-between py-4">
                        <CardTitle className="text-sm font-bold text-white uppercase tracking-wider">Active Task Queue</CardTitle>
                        <span className="text-[10px] bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded-full">Queue: {tasks.filter(t => t.status === 'pending').length}</span>
                      </CardHeader>
                      <CardContent className="p-0">
                        <Table>
                          <TableHeader className="bg-[#0c0c0c]">
                            <TableRow className="border-slate-800 hover:bg-transparent">
                              <TableHead className="text-slate-500 font-mono text-[10px] uppercase tracking-widest pl-6">Job Name</TableHead>
                              <TableHead className="text-slate-500 font-mono text-[10px] uppercase tracking-widest">Status</TableHead>
                              <TableHead className="text-slate-500 font-mono text-[10px] uppercase tracking-widest">Schedule</TableHead>
                              <TableHead className="text-slate-500 font-mono text-[10px] uppercase tracking-widest">Last Run</TableHead>
                              <TableHead className="text-right text-slate-500 font-mono text-[10px] uppercase tracking-widest pr-6">Control</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {tasks.map(task => (
                              <TableRow key={task.id} className="border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                                <TableCell className="font-semibold text-slate-200 pl-6">{task.name}</TableCell>
                                <TableCell>
                                  <StatusBadge status={task.status} />
                                </TableCell>
                                <TableCell className="font-mono text-slate-500 text-xs">{task.schedule || 'Manual'}</TableCell>
                                <TableCell className="text-slate-500 text-xs">{task.last_run ? new Date(task.last_run).toLocaleString() : 'Never'}</TableCell>
                                <TableCell className="text-right space-x-1 pr-6">
                                  <Button variant="ghost" size="icon" onClick={() => openLogViewer(task)} className="h-8 w-8 text-slate-500 hover:bg-blue-500/10 hover:text-blue-400">
                                    <Terminal size={14} />
                                  </Button>
                                  <Button variant="ghost" size="icon" onClick={() => handleRunTask(task.id)} className="h-8 w-8 text-slate-500 hover:bg-green-500/10 hover:text-green-400">
                                    <Play size={14} />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="col-span-12 xl:col-span-4 space-y-6">
                    <Card className="bg-slate-900 border-slate-800">
                      <CardHeader className="py-4 border-b border-slate-800">
                        <CardTitle className="text-[11px] uppercase font-bold text-slate-500">Upcoming Schedules</CardTitle>
                      </CardHeader>
                      <CardContent className="p-4 space-y-4">
                        <div className="flex items-start gap-3">
                          <div className="text-xs font-mono text-blue-400 mt-1">14:00</div>
                          <div>
                            <div className="text-xs font-semibold text-slate-300">Daily Lead Export</div>
                            <div className="text-[10px] text-slate-500 tracking-tight">Cron: 0 14 * * *</div>
                          </div>
                        </div>
                        <div className="flex items-start gap-3 opacity-50">
                          <div className="text-xs font-mono text-slate-500 mt-1">15:30</div>
                          <div>
                            <div className="text-xs font-semibold text-slate-300">Status Report Gen</div>
                            <div className="text-[10px] text-slate-500 tracking-tight">Every 6 hours</div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                </div>
              </motion.div>
            ) : activeTab === 'settings' ? (
              <motion.div 
                 key="settings"
                 initial={{ opacity: 0 }} 
                 animate={{ opacity: 1 }}
                 className="max-w-2xl space-y-8"
              >
                <h1 className="text-2xl font-bold tracking-tight text-white underline decoration-blue-600 decoration-4 underline-offset-8">API Configuration</h1>
                
                <div className="space-y-6">
                  <Card className="bg-slate-900 border-slate-800 shadow-xl">
                    <CardHeader>
                      <CardTitle className="text-white text-base">Cerebras AI Orchestration</CardTitle>
                      <CardDescription className="text-slate-400 text-xs">Configure key rotation for high-throughput browser automation.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">API Key Pool</Label>
                        <div className="flex space-x-2">
                          <Input className="bg-[#020617] border-slate-800 text-sm focus:ring-blue-500" placeholder="••••••••••••••••" type="password" />
                          <Button className="bg-blue-600 hover:bg-blue-700 text-white font-semibold h-9 px-4 rounded-md">Add Key</Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-slate-900 border-slate-800 shadow-xl">
                    <CardHeader>
                      <CardTitle className="text-white text-base">Anti-Detection (NopeCHA)</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label className="text-[10px] uppercase font-bold tracking-widest text-slate-500">NopeCHA API Key</Label>
                        <Input className="bg-[#020617] border-slate-800 text-sm focus:ring-blue-500" placeholder="Enter your key..." />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* Bottom Status Bar */}
        <footer className="h-8 bg-[#020617] border-t border-slate-800 px-4 flex items-center justify-between text-[10px] font-mono text-slate-500 shrink-0">
          <div className="flex gap-4">
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Supabase Connected</span>
            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Actions Active</span>
          </div>
          <div>v1.4.2-stable | Cluster-01 | Latency: 42ms</div>
        </footer>
      </main>

      {/* Log Viewer Modal */}
      <Dialog open={!!selectedTask} onOpenChange={(open) => !open && closeLogViewer()}>
        <DialogContent className="max-w-5xl bg-[#0a0a0a] border-slate-800 text-white p-0 overflow-hidden shadow-2xl">
          <DialogHeader className="p-4 border-b border-slate-800 bg-[#0c0c0c]">
            <DialogTitle className="flex items-center space-x-3 text-sm">
              <Terminal className="text-blue-500 w-4 h-4" />
              <span className="font-mono tracking-tight text-slate-300">Live Console — {selectedTask?.name}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="h-[550px] flex">
            <ScrollArea className="flex-1 bg-black p-4 font-mono text-[11px] leading-relaxed">
              <div className="space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className={`flex space-x-3 ${log.type === 'error' ? 'text-red-400' : log.type === 'success' ? 'text-green-400' : 'text-slate-400'}`}>
                    <span className="opacity-20 select-none">{i.toString().padStart(3, '0')}</span>
                    <span><span className={`opacity-50 mr-2`}>[{log.type.toUpperCase()}]</span>{log.message}</span>
                  </div>
                ))}
                {logs.length === 0 && <div className="text-slate-700 italic">Connecting to worker stream...</div>}
              </div>
            </ScrollArea>
            <aside className="w-80 bg-[#0c0c0c] border-l border-slate-800 p-6 space-y-6">
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">Live Feed</h4>
                <div className="aspect-video bg-slate-800 rounded-lg flex items-center justify-center border border-slate-700 shadow-inner group relative overflow-hidden">
                   <Eye size={20} className="text-slate-600 group-hover:text-blue-500 transition-colors" />
                   <div className="absolute inset-0 bg-blue-500/5 group-hover:bg-transparent" />
                </div>
              </div>
              <div className="space-y-4">
                <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">Reasoning Stream</h4>
                <div className="space-y-2">
                  <ReasoningItem msg="Identifying interactive targets" />
                  <ReasoningItem msg="Simulating human trajectory" />
                  <ReasoningItem msg="Bypassing CAPTCHA challenge" />
                </div>
              </div>
            </aside>
          </div>
          <DialogFooter className="p-3 border-t border-slate-800 bg-[#0c0c0c]">
             <Button variant="ghost" size="sm" onClick={closeLogViewer} className="text-xs text-slate-500 hover:text-white">Close Stream</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SidebarLink({ icon, label, active, onClick }: { icon: any; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center space-x-3 px-3 py-2 rounded-md transition-all text-sm font-medium ${
        active ? 'bg-slate-800 text-white shadow-sm' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'
      }`}
    >
      <span className={active ? 'text-blue-500' : 'text-slate-500'}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function StatCard({ label, value, trend, color = "text-white" }: { label: string; value: string; trend: string; color?: string }) {
  return (
    <Card className="bg-slate-900 border-slate-800 hover:border-blue-500/30 transition-all p-5 shadow-sm">
      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-3">{label}</div>
      <div className="flex justify-between items-end">
        <div className={`text-2xl font-semibold tracking-tight ${color}`}>{value}</div>
        <div className="text-[10px] text-blue-400 font-mono bg-blue-400/10 px-1.5 py-0.5 rounded-md border border-blue-400/20">{trend}</div>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors = {
    pending: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
    running: 'bg-blue-500/10 text-blue-500 border-blue-500/20 animate-pulse',
    completed: 'bg-green-500/10 text-green-500 border-green-500/20',
    failed: 'bg-red-500/10 text-red-500 border-red-500/20',
  };
  return (
    <Badge variant="outline" className={`${colors[status as keyof typeof colors]} uppercase text-[9px] tracking-widest font-bold rounded-sm h-5`}>
      {status}
    </Badge>
  );
}

function ReasoningItem({ msg }: { msg: string }) {
  return (
    <div className="text-[10px] p-2 bg-[#020617] border border-slate-800 rounded text-slate-400 flex items-center space-x-2">
      <div className="w-1 h-1 bg-blue-500 rounded-full shrink-0" />
      <span className="font-mono">{msg}</span>
    </div>
  );
}
