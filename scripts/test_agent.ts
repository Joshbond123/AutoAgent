#!/usr/bin/env npx tsx
/**
 * AutoAgent Pro - Agent Integration Test Suite
 * Tests: navigation, form filling, data extraction, human-like interaction, session persistence
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, details: "OK", duration: Date.now() - start });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (err: any) {
    results.push({ name, passed: false, details: err.message, duration: Date.now() - start });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

async function testSupabaseConnection() {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data, error } = await client.from("tasks").select("count").limit(1);
  if (error) throw new Error(`Supabase error: ${error.message}`);
}

async function testTaskCreation() {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data, error } = await client.from("tasks").insert({
    name: "TEST_TASK_" + Date.now(),
    prompt: "Navigate to https://example.com and extract the page title",
    status: "pending",
  }).select().single();
  if (error) throw new Error(`Insert failed: ${error.message}`);
  if (!data?.id) throw new Error("No task ID returned");
  // Cleanup
  await client.from("tasks").delete().eq("id", data.id);
}

async function testTaskLogInsert() {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  // Create a temp task first
  const { data: task } = await client.from("tasks").insert({
    name: "LOG_TEST_" + Date.now(),
    prompt: "test",
    status: "pending",
  }).select().single();
  if (!task) throw new Error("Could not create test task");
  
  const { error } = await client.from("task_logs").insert({
    task_id: task.id,
    message: "Test log entry",
    log_type: "info",
  });
  if (error) throw new Error(`Log insert failed: ${error.message}`);
  // Cleanup
  await client.from("tasks").delete().eq("id", task.id);
}

async function testSettingsUpsert() {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  // Check table exists
  const { error } = await client.from("settings").select("user_id").limit(1);
  if (error && !error.message.includes("no rows")) throw new Error(`Settings table error: ${error.message}`);
}

async function testBrowserPlaywright() {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  
  await page.goto("https://example.com", { timeout: 30000 });
  const title = await page.title();
  await browser.close();
  
  if (!title) throw new Error("No page title extracted");
  console.log(`    → Page title: "${title}"`);
}

async function testHumanLikeTyping() {
  const playwright = await import("playwright");
  const { randomBetween } = await import("../lib/utils.js");
  
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("https://www.google.com", { timeout: 30000 });
  
  // Type with human delays
  const searchBox = await page.waitForSelector('textarea[name="q"]', { timeout: 10000 });
  if (!searchBox) throw new Error("Search box not found");
  
  for (const char of "AutoAgent test") {
    await page.keyboard.type(char, { delay: randomBetween(50, 150) });
  }
  
  const value = await searchBox.inputValue();
  await browser.close();
  
  if (!value.includes("AutoAgent")) throw new Error("Typing test failed");
  console.log(`    → Typed: "${value}"`);
}

async function testFormNavigation() {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  
  // Test multi-step navigation
  await page.goto("https://httpbin.org/forms/post", { timeout: 30000 });
  await page.waitForSelector("form", { timeout: 10000 });
  
  const inputs = await page.$$("input[type=text]");
  if (inputs.length === 0) throw new Error("No text inputs found");
  
  // Fill first input
  await inputs[0].type("Test Value", { delay: 80 });
  const value = await inputs[0].inputValue();
  
  await browser.close();
  if (!value.includes("Test")) throw new Error("Form fill failed");
  console.log(`    → Form filled with: "${value}"`);
}

async function testDataExtraction() {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  
  await page.goto("https://httpbin.org/json", { timeout: 30000 });
  const bodyText = await page.textContent("pre, body");
  await browser.close();
  
  if (!bodyText || bodyText.length < 10) throw new Error("No data extracted");
  console.log(`    → Extracted ${bodyText.length} bytes of data`);
}

async function testSessionPersistence() {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext();
  
  const page1 = await context.newPage();
  await page1.goto("https://httpbin.org/cookies/set?test_session=autoagent123", { timeout: 30000 });
  
  const page2 = await context.newPage();
  await page2.goto("https://httpbin.org/cookies", { timeout: 30000 });
  const body = await page2.textContent("pre, body");
  
  await browser.close();
  if (!body?.includes("autoagent123")) throw new Error("Session not persisted across pages");
  console.log(`    → Session persisted: cookie 'test_session' carried over`);
}

async function testStealthFingerprint() {
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
    ]
  });
  const context = await browser.newContext();
  
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });
  
  const page = await context.newPage();
  await page.goto("https://httpbin.org/user-agent", { timeout: 30000 });
  
  const webdriverValue = await page.evaluate(() => navigator.webdriver);
  await browser.close();
  
  if (webdriverValue === true) throw new Error("WebDriver flag exposed — stealth failed");
  console.log(`    → navigator.webdriver = ${webdriverValue} (hidden)`);
}

// Main test runner
async function main() {
  console.log("\n========================================");
  console.log("  AutoAgent Pro — Integration Test Suite");
  console.log("========================================\n");

  console.log("📦 Database Tests:");
  await runTest("Supabase connection", testSupabaseConnection);
  await runTest("Task CRUD operations", testTaskCreation);
  await runTest("Task log insertion", testTaskLogInsert);
  await runTest("Settings table access", testSettingsUpsert);

  console.log("\n🌐 Browser Automation Tests:");
  await runTest("Playwright browser launch", testBrowserPlaywright);
  await runTest("Human-like typing with delays", testHumanLikeTyping);
  await runTest("Multi-step form navigation", testFormNavigation);
  await runTest("Data extraction from page", testDataExtraction);
  await runTest("Session persistence (cookies)", testSessionPersistence);
  await runTest("Stealth fingerprint (webdriver hidden)", testStealthFingerprint);

  console.log("\n========================================");
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;
  
  console.log(`Results: ${passed}/${total} tests passed ${allPassed ? "✓" : "✗"}`);
  if (!allPassed) {
    console.log("\nFailed tests:");
    results.filter(r => !r.passed).forEach(r => console.log(`  ✗ ${r.name}: ${r.details}`));
  }
  console.log("========================================\n");

  process.exit(allPassed ? 0 : 1);
}

main().catch(err => { console.error("Test runner error:", err); process.exit(1); });
