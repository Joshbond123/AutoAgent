import { createClient } from "@supabase/supabase-js";
import { AutonomousAgent } from "../lib/agent.js";
import dotenv from "dotenv";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const NOPECHA_API_KEY = process.env.NOPECHA_API_KEY || "";
const TASK_ID = process.env.TASK_ID || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function log(taskId: string, message: string, type: "info" | "success" | "error" | "warning" = "info") {
  console.log(`[${type.toUpperCase()}] ${message}`);
  await supabase.from("task_logs").insert({ task_id: taskId, message, log_type: type });
}

async function runTask(taskId: string): Promise<void> {
  console.log(`\n========== Running Task: ${taskId} ==========`);

  const { data: task, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("id", taskId)
    .single();

  if (error || !task) {
    console.error(`Task not found: ${taskId}`);
    return;
  }

  await supabase
    .from("tasks")
    .update({ status: "running", last_run: new Date().toISOString() })
    .eq("id", taskId);

  await log(taskId, `Starting task: ${task.name}`, "info");

  const agent = new AutonomousAgent({
    taskId,
    prompt: task.prompt,
    geminiApiKey: GEMINI_API_KEY,
    nopechaKey: NOPECHA_API_KEY,
    onLog: async (message, type = "info") => {
      await log(taskId, message, type);
    },
    onScreenshot: async (base64) => {
      try {
        const buffer = Buffer.from(base64, "base64");
        const filename = `${taskId}/${Date.now()}.jpg`;
        await supabase.storage.from("screenshots").upload(filename, buffer, { contentType: "image/jpeg" });
      } catch (err) {
        console.warn("Screenshot upload failed:", err);
      }
    },
    maxSteps: 25,
  });

  const result = await agent.run();

  await supabase
    .from("tasks")
    .update({
      status: result.success ? "completed" : "failed",
      result: {
        success: result.success,
        summary: result.summary,
        stepCount: result.logs.length,
        completedAt: new Date().toISOString(),
      },
      logs: result.logs.join("\n"),
    })
    .eq("id", taskId);

  await log(
    taskId,
    result.success ? `Task completed: ${result.summary}` : `Task failed: ${result.summary}`,
    result.success ? "success" : "error"
  );

  console.log(`Task ${taskId} finished. Success: ${result.success}`);
}

async function runPendingTasks(): Promise<void> {
  console.log("Checking for pending/scheduled tasks...");

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("*")
    .in("status", ["pending", "scheduled"])
    .order("created_at", { ascending: true })
    .limit(3);

  if (error) {
    console.error("Error fetching tasks:", error);
    return;
  }

  if (!tasks || tasks.length === 0) {
    console.log("No pending tasks found.");
    return;
  }

  console.log(`Found ${tasks.length} pending task(s).`);

  // Process tasks sequentially to avoid resource conflicts
  for (const task of tasks) {
    await runTask(task.id);
  }
}

// Main entry point
async function main() {
  if (TASK_ID) {
    await runTask(TASK_ID);
  } else {
    await runPendingTasks();
  }
}

main().catch(err => {
  console.error("Worker fatal error:", err);
  process.exit(1);
});
