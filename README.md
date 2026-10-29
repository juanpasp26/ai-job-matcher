# AI Job Matcher

A scheduled pipeline that finds student data and AI jobs in Prague every week, has Claude screen each one against a candidate profile, and emails a ranked shortlist of the best 10.

I built it because I was spending hours every week scrolling job boards and opening offers that turned out to need Czech, a finished degree or five years of experience.

## How it works

```
Every Monday 08:00 (Europe/Prague)
        │
        ▼
1. Search    10 queries to the JSearch API (data analyst intern, AI automation intern, ...)
        │    deduplicate by job ID and by title + company
        ▼
2. Filter    cheap keyword pre-filter: drop senior/lead/manager titles and "fluent Czech" posts
        │
        ▼
3. Screen    Claude reads each offer in batches of 10 and returns structured JSON,
        │    validated with a Zod schema: Czech required? paid? internship or part-time?
        │    location OK? fit score 0–100, short summary
        ▼
4. Rank      keep offers that pass every hard rule and score ≥ 50, sort by fit, take the top 10
        │
        ▼
5. Deliver   HTML email via Resend (also sent when nothing matches, so I know it ran)
```

## Design choices

- **Hard rules in code, judgment in the model.** Claude only reports facts (is Czech mandatory, is it paid, what type of contract) and a fit score. The decision to keep or drop an offer is plain TypeScript, so the rules are easy to read and change.
- **Structured output.** The response is parsed against a Zod schema, so a malformed answer fails loudly instead of slipping bad data into the email.
- **Cheap first, smart second.** A regex pre-filter removes obvious misses before any tokens are spent, and descriptions are cut to 5,000 characters.
- **Fails safely.** A single failing search is logged and skipped. If every search fails, the run throws and Trigger.dev retries it with exponential backoff.
- **No secrets in code.** Every key is read from environment variables and validated at the start of the run.

## Stack

TypeScript · [Trigger.dev v4](https://trigger.dev) (scheduling, retries, logs) · Claude API (`claude-haiku-5-5`, structured outputs) · Zod · JSearch API · Resend

## Run it yourself

```bash
npm install
cp .env.example .env        # fill in your keys
# put your Trigger.dev project ref in trigger.config.ts
npx trigger.dev@latest dev  # then trigger "weekly-student-jobs" from the dashboard
```

Change `SEARCHES` and `STUDENT_PROFILE` at the top of `src/trigger/weekly-jobs/weekly-jobs.ts` to match your own search.

## Cost

About 40 JSearch requests a month (inside the free tier) and a few cents of Claude Haiku per run.
