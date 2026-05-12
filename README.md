# AutoAgent Pro — Autonomous Browser Agent Platform

AutoAgent Pro is a next-generation autonomous browser agent platform powered by **browser-use** (Python), **Cerebras AI**, and **Cloudflare Workers AI**. It runs fully automated browser tasks via GitHub Actions and streams live updates to the dashboard in real time.

---

## Architecture

- **Frontend**: React + Vite SPA deployed to GitHub Pages
- **Browser Engine**: [`browser-use`](https://github.com/browser-use/browser-use) Python library (Playwright + LangChain)
- **Primary AI**: Cerebras API (LangChain OpenAI wrapper) — ultra-fast inference
- **Vision AI**: Cloudflare Workers AI (kimi-k2.6, llama-3.3-70b, etc.)
- **Database**: Supabase (PostgreSQL + Realtime)
- **Task Execution**: GitHub Actions (workflow_dispatch + 10-minute cron schedule)

---

## 1. Supabase Setup

Run this SQL in your Supabase **SQL Editor**:

```sql
-- Tasks Table
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id),
  name TEXT,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  last_run TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Task logs (text + screenshots)
CREATE TABLE IF NOT EXISTS task_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  message TEXT,
  log_type TEXT DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User settings
CREATE TABLE IF NOT EXISTS settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  cerebras_keys TEXT[],
  nopecha_key TEXT,
  cloudflare_account_id TEXT,
  cloudflare_keys TEXT[],
  cloudflare_model TEXT DEFAULT '@cf/moonshotai/kimi-k2.6',
  github_token TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own tasks" ON tasks
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users view own logs" ON task_logs
  FOR ALL USING (
    task_id IN (SELECT id FROM tasks WHERE user_id = auth.uid())
  );

CREATE POLICY "Service role can manage logs" ON task_logs
  FOR ALL USING (true);

CREATE POLICY "Users manage own settings" ON settings
  FOR ALL USING (auth.uid() = user_id);
```

Enable **Realtime** on the `tasks` and `task_logs` tables in Supabase Dashboard → Database → Replication.

---

## 2. GitHub Actions Secrets

Go to your GitHub repo → **Settings → Secrets and Variables → Actions** → add:

| Secret | Description |
|--------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (not anon key) |
| `CEREBRAS_API_KEYS` | Comma-separated Cerebras API keys |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (optional) |
| `CLOUDFLARE_API_KEY` | Cloudflare API key (optional) |
| `CLOUDFLARE_MODEL` | Cloudflare model ID (optional) |
| `NOPECHA_API_KEY` | NopeCHA key for CAPTCHA solving (optional) |
| `VITE_SUPABASE_URL` | Same as SUPABASE_URL (for frontend build) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key (for frontend build) |

---

## 3. Settings (In-App)

Open the app → **Settings** and configure:

- **Cerebras AI**: Add one or more API keys from [cerebras.ai](https://cerebras.ai)
- **Cloudflare AI**: Add Cloudflare account credentials for vision fallback
- **GitHub PAT**: Add a Personal Access Token with `repo` scope for **instant execution** (skips the 10-minute cron wait)
- **NopeCHA**: For automatic CAPTCHA solving (optional)

---

## 4. How Task Execution Works

1. User submits a task in the dashboard
2. Task is saved to Supabase with `status: "pending"`
3. If a GitHub PAT is configured → GitHub Actions `workflow_dispatch` is triggered immediately
4. Otherwise → waits for the 10-minute cron schedule
5. GitHub Actions runs `scripts/browser_use_worker.py <task_id>`
6. The worker:
   - Loads user settings (AI keys) from Supabase
   - Marks task as `running`
   - Launches **browser-use** agent with Cerebras LLM
   - Streams logs + screenshots to `task_logs` in real time
   - Marks task as `completed` or `failed`
7. Dashboard receives live updates via Supabase Realtime

---

## 5. browser-use Engine

The `scripts/browser_use_worker.py` uses the **browser-use** Python library:

```python
from browser_use import Agent, Browser, BrowserConfig
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="https://api.cerebras.ai/v1",
    api_key=cerebras_key,
    model="llama3.1-8b",
    temperature=0.0,
)

agent = Agent(task=prompt, llm=llm, browser=browser)
history = await agent.run(max_steps=50)
```

browser-use autonomously navigates websites, fills forms, clicks buttons, extracts data, and handles multi-step workflows — all powered by the Cerebras LLM.

---

## 6. Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Fill in your SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.

# Start dev server
npm run dev
```

For local Python worker testing:
```bash
pip install browser-use langchain-openai langchain supabase httpx playwright
playwright install chromium --with-deps
python scripts/browser_use_worker.py <task_id>
```
