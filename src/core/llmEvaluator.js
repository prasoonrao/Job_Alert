'use strict';

const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

// ─── Load candidate profile ────────────────────────────────────────────────
const PROFILE_PATH = path.join(__dirname, '..', '..', 'data', 'resume_profile.json');
let candidateProfile;
try {
  candidateProfile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
} catch {
  console.warn('[LLM] Could not load resume_profile.json — using fallback profile.');
  candidateProfile = {
    name: 'CS Student',
    coreStack: ['Node.js', 'JavaScript', 'REST APIs'],
    targetRoles: ['Software Engineer Intern'],
    experienceLevel: 'Fresher',
  };
}

const PROFILE_SUMMARY = `
Name: ${candidateProfile.name}
Education: ${candidateProfile.education || 'CS Student'}
Core Tech Stack: ${candidateProfile.coreStack.join(', ')}
Interests: ${(candidateProfile.interests || []).join(', ')}
Target Roles: ${candidateProfile.targetRoles.join(', ')}
Target Locations: ${(candidateProfile.targetLocations || []).join(', ')}
Experience Level: ${candidateProfile.experienceLevel || 'Fresher'}
`.trim();

// ─── Polite delay to stay within Gemini rate limits (15 RPM free tier) ────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Evaluate a single job against the candidate profile using Gemini 1.5 Flash.
 * Returns the original job object enriched with matchScore, aiReason, coldPitch.
 * On failure, returns the original job unchanged (graceful degradation).
 */
async function evaluateSingleJob(ai, job) {
  const prompt = `You are an expert tech recruiter evaluating a job listing for a specific candidate.

CANDIDATE PROFILE:
${PROFILE_SUMMARY}

JOB LISTING:
Title: ${job.title || 'Unknown'}
Company: ${job.company || 'Unknown'}
Location: ${job.location || 'Not specified'}
Type: ${job.type || 'Unknown'}
Source: ${job.source || 'Unknown'}
Description: ${(job.description || 'No description available').slice(0, 800)}

TASKS:
1. Provide a match score from 0 to 100 based on how well this job aligns with the candidate's stack, experience level, interests, and target locations.
2. Write exactly 1 sentence explaining the score (focus on stack alignment and level fit).
3. Write a 2-sentence polite cold outreach message the candidate could send to a recruiter or hiring manager on LinkedIn to express interest.

Return ONLY valid JSON with this exact schema:
{"matchScore": 85, "reason": "Strong match because...", "coldPitch": "Hi, I noticed..."}`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
         // Low temperature for consistent, factual scoring
      },
    });

    const text = response.text;
    const result = JSON.parse(text);

    return {
      ...job,
      matchScore: Math.min(100, Math.max(0, Number(result.matchScore) || 0)),
      aiReason: (result.reason || '').slice(0, 200),
      coldPitch: (result.coldPitch || '').slice(0, 300),
    };
  } catch (err) {
    console.warn(`[LLM] ⚠️ Failed to evaluate "${job.title}" @ ${job.company}: ${err.message}`);
    return job; // Graceful fallback — job passes through unscored
  }
}

/**
 * Evaluate an array of jobs against the candidate profile.
 * Jobs are processed sequentially with a delay to respect rate limits.
 *
 * @param {Array} jobs - Array of filtered job objects
 * @returns {Array} - Same jobs with matchScore, aiReason, coldPitch appended (where available)
 */
async function evaluateJobs(jobs) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('[LLM] GEMINI_API_KEY not set — skipping LLM evaluation.');
    return jobs;
  }

  const ai = new GoogleGenAI({ apiKey });

  // IMPORTANT:
  // Do NOT send hundreds of jobs to Gemini in one GitHub Actions run.
  // Telegram only needs the best jobs, so evaluate a limited shortlist.
  const MAX_LLM_JOBS = 50;

  const jobsToEvaluate = jobs.slice(0, MAX_LLM_JOBS);
  const remainingJobs = jobs.slice(MAX_LLM_JOBS);

  console.log(
    `[LLM] Evaluating ${jobsToEvaluate.length}/${jobs.length} jobs against candidate profile...`
  );

  const evaluated = [];

  for (let i = 0; i < jobsToEvaluate.length; i++) {
    const job = jobsToEvaluate[i];

    console.log(
      `[LLM] ${i + 1}/${jobsToEvaluate.length}: "${job.title}" @ ${job.company}`
    );

    const result = await evaluateSingleJob(ai, job);
    evaluated.push(result);

    if (result.matchScore != null) {
      console.log(
        `[LLM]    → Score: ${result.matchScore}% | ${result.aiReason || ''}`
      );
    }

    // Small delay between requests.
    // Actual request time also contributes to the spacing.
    if (i < jobsToEvaluate.length - 1) {
      await sleep(4000);
    }
  }

  // Jobs not evaluated by Gemini are still returned unchanged.
  const finalJobs = [...evaluated, ...remainingJobs];

  const scored = evaluated.filter(j => j.matchScore != null);

  console.log(
    `[LLM] ✅ Scored ${scored.length}/${jobsToEvaluate.length} evaluated jobs.`
  );

  if (scored.length > 0) {
    const avg = Math.round(
      scored.reduce((sum, j) => sum + j.matchScore, 0) / scored.length
    );

    const high = scored.filter(j => j.matchScore >= 80).length;

    console.log(
      `[LLM] Average score: ${avg}% | High matches (≥80%): ${high}`
    );
  }

  console.log(
    `[LLM] ⏭️ Skipped LLM evaluation for ${remainingJobs.length} additional jobs.`
  );

  return finalJobs;
}
module.exports = { evaluateJobs };
