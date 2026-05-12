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

  io.on("connection", (socket) => {
    socket.on("subscribe:task", (taskId) => socket.join(`task:${taskId}`));
    socket.on("unsubscribe:task", (taskId) => socket.leave(`task:${taskId}`));
  });

  app.get("/api/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

  app.post("/api/tasks/:id/execute", async (req, res) => {
    const { id } = req.params;
    if (!supabase) return res.status(503).json({ error: "Database not configured" });

    runTask(id, io, supabase).catch(err => console.error(`Task ${id} error:`, err));
    res.json({ message: "Task queued", taskId: id });
  });

  app.get("/api/tasks", async (_, res) => {
    if (!supabase) return res.status(503).json({ error: "Database not configured" });
    const { data, error } = await supabase.from("tasks").select("*").order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

async function runTask(taskId: string, io: Server, supabase: any) {
  io.to(`task:${taskId}`).emit("log", { message: "Queued for GitHub Actions execution...", type: "info" });
  await supabase.from("tasks").update({ status: "pending", last_run: new Date() }).eq("id", taskId);
}

startServer().catch(console.error);
