# AutoAgent Pro - Deployment & Configuration Guide

AutoAgent Pro is a next-generation autonomous browser agent platform built for scale, reliability, and human-like interaction.

## 1. Prerequisites

- **Supabase Project**: Create a new project at [supabase.com](https://supabase.com).
- **Gemini API Key**: Obtain a key from Google AI Studio.
- **Optional**: NopeCHA API key, Cerebras API keys.

## 2. Supabase Setup

Execute the following SQL in your Supabase SQL Editor:

```sql
-- Tasks Table
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID DEFAULT auth.uid(),
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  schedule TEXT,
  last_run TIMESTAMPTZ,
  result JSONB,
  logs TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings Table
CREATE TABLE settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  cerebras_keys TEXT[],
  nopecha_key TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## 3. GitHub Actions Configuration

1. Fork/Push this repository to GitHub.
2. Go to **Settings > Secrets and Variables > Actions**.
3. Add the following repository secrets:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`
   - `CEREBRAS_API_KEYS` (Comma-separated list)
   - `NOPECHA_API_KEY`

## 4. Local Development

1. Create a `.env` file based on `.env.example`.
2. Install dependencies: `npm install`.
3. Start the dev server: `npm run dev`.

## 5. Security Note

Credentials should always be stored as GitHub Secrets or in Supabase's secure vault. Never commit raw API keys to the repository.

---

Built with Chrome, Playwright, and Gemini AI.
