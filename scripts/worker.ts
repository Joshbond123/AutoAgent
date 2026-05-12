import { createClient } from "@supabase/supabase-js";
import { AutonomousAgent } from "../lib/agent.js";
import dotenv from "dotenv";

dotenv.config();

async function runWorker() {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const supabase = createClient(supabaseUrl, supabaseKey);

  const taskId = process.env.TASK_ID;
  
  let task;
  if (taskId) {
    const { data } = await supabase.from('tasks').select('*').eq('id', taskId).single();
    task = data;
  } else {
    // If no specific task, pick up next pending task with a schedule
    const { data } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    task = data;
  }

  if (!task) {
    console.log("No pending tasks found.");
    return;
  }

  console.log(`Starting worker for task: ${task.name} (${task.id})`);

  const geminiKey = process.env.GEMINI_API_KEY || "";
  const cerebrasKeys = (process.env.CEREBRAS_API_KEYS || "").split(",").filter(k => !!k);

  const agent = new AutonomousAgent(geminiKey, cerebrasKeys);
  
  agent.setLogCallback(async (msg, type) => {
    console.log(`[${type}] ${msg}`);
    // Optionally update logs in Supabase in chunks
  });

  try {
    await agent.initialize({ headless: true });
    await supabase.from('tasks').update({ status: 'running', last_run: new Date() }).eq('id', task.id);
    
    await agent.run(task.prompt);

    await supabase.from('tasks').update({ 
      status: 'completed',
      updated_at: new Date()
    }).eq('id', task.id);

  } catch (err: any) {
    console.error("Worker Execution Error:", err);
    await supabase.from('tasks').update({ 
      status: 'failed',
      logs: err.message
    }).eq('id', task.id);
  } finally {
    await agent.close();
    process.exit(0);
  }
}

runWorker();
