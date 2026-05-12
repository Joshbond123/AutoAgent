import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = parseInt(process.env.PORT || "3000", 10);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: "*" } });

  app.use(express.json());

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  // ── Socket.IO for real-time task subscriptions ─────────────────────────────
  io.on("connection", (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    socket.on("subscribe:task", (taskId) => {
      socket.join(`task:${taskId}`);
      console.log(`[Socket] ${socket.id} subscribed to task:${taskId}`);
    });
    socket.on("unsubscribe:task", (taskId) => {
      socket.leave(`task:${taskId}`);
    });
    socket.on("disconnect", () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });

  // ── Health check ───────────────────────────────────────────────────────────
  app.get("/api/health", (_, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      supabase: supabase ? "connected" : "not configured",
      engine: "browser-use",
    });
  });

  // ── Dispatch a specific task to GitHub Actions ─────────────────────────────
  app.post("/api/tasks/:id/execute", async (req, res) => {
    const { id } = req.params;
    if (!supabase) return res.status(503).json({ error: "Database not configured" });

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, status, user_id")
      .eq("id", id)
      .single();

    if (taskError || !task) {
      return res.status(404).json({ error: "Task not found" });
    }

    // Get the github_token from user settings
    const { data: settings } = await supabase
      .from("settings")
      .select("github_token")
      .eq("user_id", task.user_id)
      .single();

    const githubToken = settings?.github_token || process.env.GITHUB_PAT || "";

    if (githubToken) {
      // Trigger GitHub Actions workflow_dispatch
      try {
        const r = await fetch(
          "https://api.github.com/repos/Joshbond123/AutoAgent/actions/workflows/agent-task.yml/dispatches",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ref: "main", inputs: { task_id: id } }),
          }
        );

        if (r.ok || r.status === 204) {
          await supabase.from("task_logs").insert({
            task_id:    id,
            message:    "⚡ GitHub Actions dispatched — browser-use agent starting…",
            log_type:   "info",
            created_at: new Date().toISOString(),
          });
          io.to(`task:${id}`).emit("log", { message: "GitHub Actions dispatched", type: "info" });
          return res.json({ message: "Workflow dispatched", taskId: id });
        } else {
          console.error(`[Execute] GitHub dispatch failed: ${r.status}`);
        }
      } catch (err) {
        console.error("[Execute] GitHub dispatch error:", err);
      }
    }

    // No token or dispatch failed — set status to pending for scheduled pickup
    await supabase.from("tasks").update({
      status:   "pending",
      last_run: new Date().toISOString(),
    }).eq("id", id);

    io.to(`task:${id}`).emit("log", {
      message: "Queued — waiting for next GitHub Actions schedule (~10 min). Add a GitHub PAT in Settings for instant execution.",
      type: "info",
    });

    res.json({ message: "Task queued for scheduled execution", taskId: id });
  });

  // ── List tasks ─────────────────────────────────────────────────────────────
  app.get("/api/tasks", async (_, res) => {
    if (!supabase) return res.status(503).json({ error: "Database not configured" });
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // ── Task logs ──────────────────────────────────────────────────────────────
  app.get("/api/tasks/:id/logs", async (req, res) => {
    if (!supabase) return res.status(503).json({ error: "Database not configured" });
    const { data, error } = await supabase
      .from("task_logs")
      .select("*")
      .eq("task_id", req.params.id)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  // ── Vite dev / static production ──────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] AutoAgent Pro running on http://localhost:${PORT}`);
    console.log(`[Server] Engine: browser-use (Playwright + LangChain + Cerebras AI)`);
  });
}

startServer().catch(console.error);
