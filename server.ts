import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import playwright from "playwright";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  app.use(express.json());

  // Supabase Client
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Socket.io for live logs
  io.on("connection", (socket) => {
    console.log("Client connected to socket:", socket.id);
    
    socket.on("subscribe:task", (taskId) => {
      socket.join(`task:${taskId}`);
      console.log(`Socket ${socket.id} subscribed to task:${taskId}`);
    });

    socket.on("unsubscribe:task", (taskId) => {
      socket.leave(`task:${taskId}`);
    });
  });

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Execute Task Endpoint
  app.post("/api/tasks/:id/execute", async (req, res) => {
    const { id } = req.params;
    
    // In a real production app, we'd fire and forget or use a queue
    // For this example, we'll return immediately and let it run in background
    runTask(id, io, supabase).catch(err => {
      console.error(`Task ${id} execution error:`, err);
    });

    res.json({ message: "Task started", taskId: id });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

/**
 * Task Execution Logic (Placeholder for full agent)
 */
async function runTask(taskId: string, io: Server, supabase: any) {
  console.log(`Starting task execution for ${taskId}...`);
  io.to(`task:${taskId}`).emit("log", { message: "Initializing browser...", type: "info" });

  try {
    const { data: task, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    if (error || !task) throw new Error("Task not found");

    await supabase.from("tasks").update({ status: "running", last_run: new Date() }).eq("id", taskId);

    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    io.to(`task:${taskId}`).emit("log", { message: "Browser launched. Navigating...", type: "success" });
    
    // Simple demo logic - would be replaced by AI Agent reasoning loop
    await page.goto("https://google.com");
    const screenshot = await page.screenshot({ fullPage: true });
    
    // In a real app, upload screenshot to storage
    // const { data: uploadData } = await supabase.storage.from('screenshots').upload(`${taskId}/${Date.now()}.png`, screenshot);

    io.to(`task:${taskId}`).emit("log", { message: "Task completed successfully", type: "success" });
    
    await supabase.from("tasks").update({ 
      status: "completed", 
      result: { summary: "Navigated to Google and took screenshot" } 
    }).eq("id", taskId);

    await browser.close();
  } catch (err: any) {
    console.error(err);
    io.to(`task:${taskId}`).emit("log", { message: `Error: ${err.message}`, type: "error" });
    await supabase.from("tasks").update({ status: "failed" }).eq("id", taskId);
  }
}

startServer();
