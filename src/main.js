'use strict';

require('dotenv').config();

const { runAllScrapers } = require('./scrapers/index');
const { filterJobs } = require('./core/filter');
const { passesGeoFilter, isIndia } = require('./core/geoFilter');
const { evaluateJobs } = require('./core/llmEvaluator');
const Database = require('./core/database');
const TelegramNotifier = require('./notifiers/telegram');


// ─── Config ────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const USE_SERPAPI = process.env.USE_SERPAPI === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');
const USE_LLM = process.env.USE_LLM === 'true';

// SEED_MODE: On first deploy, run with SEED_MODE=true.
// This scrapes all current job listings, marks them ALL as "already seen"
// in the deduplication DB, but sends ZERO notifications.
// Purpose: prevents flooding Telegram/Discord with hundreds of old job posts
// that existed before the bot was set up.
// After the seed run completes, set SEED_MODE=false (or remove it) for all
// subsequent scheduled runs — only genuinely NEW jobs will be sent.
const SEED_MODE = process.env.SEED_MODE === 'true' || process.argv.includes('--seed');

// FIX Issue 10: Raised from 30 → 50. At 1.5s/message it takes ~75s to send
// 50 Telegram messages — well within GitHub Actions 15-min timeout.
const MAX_JOBS_PER_RUN = 50;

function validateConfig() {
  // In SEED_MODE we never send notifications, so credentials aren't required.
  if (SEED_MODE || DRY_RUN) return;
  const missing = [];
  if (!TELEGRAM_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('   Copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
}

/**
 * Sort jobs: India first → remote → global; within each group internships first
 */
function sortJobs(jobs) {
  return jobs.sort((a, b) => {
    // If LLM scores exist, highest match first
    if (a.matchScore != null && b.matchScore != null) {
      const scoreDiff = b.matchScore - a.matchScore;
      if (scoreDiff !== 0) return scoreDiff;
    }
    // Then by geography: India → Remote → Global
    const geoScore = j => {
      const loc = (j.location || '').toLowerCase();
      if (isIndia(loc)) return 0;
      if (loc.includes('remote') || loc.includes('wfh')) return 1;
      return 2;
    };
    const geo = geoScore(a) - geoScore(b);
    if (geo !== 0) return geo;
    // Same geo — internships before full-time
    return (a.type === 'internship' ? 0 : 1) - (b.type === 'internship' ? 0 : 1);
  });
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🤖 JOB ALERT BOT — Starting Run');
  console.log(`  Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log(`  Mode: ${USE_SERPAPI ? 'FULL (SerpAPI enabled)' : 'FREE sources only'}`);
  console.log(`  Dry Run: ${DRY_RUN ? 'YES (no messages sent)' : 'NO'}`);
  if (SEED_MODE) {
    console.log('  🌱 SEED MODE: Cataloguing all existing jobs — NO notifications will be sent.');
    console.log('  After this run, set SEED_MODE=false in your workflow for live alerts.');
  }
  console.log(`  LLM Eval: ${USE_LLM ? 'YES (Gemini 1.5 Flash)' : 'OFF'}`);
  console.log('═'.repeat(60) + '\n');

  validateConfig();

  // ── 1. Scrape ─────────────────────────────────────────────────────────────
  const rawJobs = await runAllScrapers({ useSerpapi: USE_SERPAPI });

  // ── 2. Filter by CS relevance ────────────────────────────────────────────
  const csJobs = filterJobs(rawJobs);
  console.log(`📋 After CS filter: ${csJobs.length} relevant jobs`);

  // ── 3. Filter by geography ──────────────────────────────────────────────
  const geoJobs = csJobs.filter(passesGeoFilter);
  console.log(`🌍 After geo filter: ${geoJobs.length} jobs`);

  // ── 3.5. LLM Evaluation (optional) ────────────────────────────────────
  let evaluatedJobs = geoJobs;
  if (USE_LLM && !SEED_MODE) {
    console.log(`\n🧠 Running LLM evaluation on ${geoJobs.length} jobs...`);
    evaluatedJobs = await evaluateJobs(geoJobs);
    const scored = evaluatedJobs.filter(j => j.matchScore != null);
    console.log(`🧠 LLM scored ${scored.length}/${evaluatedJobs.length} jobs`);
  }

  // ── 4. Deduplicate against DB ────────────────────────────────────────────
  const db = new Database();
  db.cleanup();

  const newJobs = evaluatedJobs.filter(job => db.isNew(job));
  console.log(`✨ New (not previously seen): ${newJobs.length} jobs`);

  // FIX Issue 5: If nothing new, exit silently — no "nothing happened" ping
  if (newJobs.length === 0) {
    console.log('✅ No new jobs found. Staying silent (silence is golden).');
    db.save();
    return;
  }

  // ── SEED MODE: mark everything as seen, send nothing ────────────────────
  if (SEED_MODE) {
    console.log(`\n🌱 [SEED MODE] Cataloguing ${newJobs.length} jobs as already seen...`);
    for (const job of newJobs) {
      db.markSeen(job);
    }
    db.save();
    const stats = db.stats();
    console.log('\n' + '═'.repeat(60));
    console.log('  🌱 Seed Run Complete!');
    console.log(`  Jobs catalogued (will NOT be sent) : ${newJobs.length}`);
    console.log(`  Total DB entries                   : ${stats.total}`);
    console.log('  Next step: set SEED_MODE=false in your workflow');
    console.log('  From next run, only NEW jobs will trigger alerts.');
    console.log('═'.repeat(60) + '\n');
    return;
  }

  // ── 5. Sort and cap ───────────────────────────────────────────────────────
  const sorted = sortJobs(newJobs);
  const toNotify = sorted.slice(0, MAX_JOBS_PER_RUN);
  const deferred = newJobs.length - toNotify.length;

  if (deferred > 0) {
    console.log(`⚠️  Capping at ${MAX_JOBS_PER_RUN} this run. ${deferred} deferred — will be sent next run.`);
  }

  // ── 6. Send notifications ─────────────────────────────────────────────────
  const runType = USE_SERPAPI ? '☀️ Morning Run (Full)' : '🌙 Evening Run (Free)';

  if (!DRY_RUN) {
    const telegram = new TelegramNotifier(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID);
   

    const results = await Promise.allSettled([
      telegram.sendJobs(toNotify, runType),
     
    ]);

    // FIX Issue 7: Only mark jobs as seen if at least one notifier succeeded.
    // If both fail, we exit with error — GitHub Actions will show the run as
    // failed and jobs will be retried next run.
    const anySucceeded = results.some(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    if (failures.length > 0) {
      console.warn(`⚠️  Some notifiers failed: ${failures.join(', ')}`);
    }

    if (!anySucceeded) {
      console.error('💥 All notifiers failed — NOT marking jobs as seen. Will retry next run.');
      process.exit(1); // Non-zero exit → GitHub Actions marks run as failed
    }

  } else {
    console.log('\n[DRY RUN] Would send these jobs:');
    toNotify.forEach((j, i) => {
      console.log(`  ${i + 1}. [${j.type}] ${j.title} @ ${j.company} | ${j.location || 'no location'} | ${j.source}`);
    });
    console.log(`[DRY RUN] Total: ${toNotify.length} jobs\n`);
  }

  // ── 7. Mark jobs as seen (only reached if at least one notifier succeeded) ─
  for (const job of toNotify) {
    db.markSeen(job);
  }
  db.save();

  // ── 8. Final summary ────────────────────────────────────────────────────
  const stats = db.stats();
  console.log('\n' + '═'.repeat(60));
  console.log('  ✅ Run Complete!');
  console.log(`  Notified this run : ${toNotify.length}`);
  console.log(`  Deferred to next  : ${deferred}`);
  console.log(`  Total DB entries  : ${stats.total}`);
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error('\n💥 Fatal error in main():', err);
  process.exit(1);
});
