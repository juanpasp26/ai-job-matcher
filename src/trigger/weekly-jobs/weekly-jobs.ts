import { logger, schedules } from "@trigger.dev/sdk";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// Every query costs 1 JSearch request (~4 runs/month → ~40 requests/month)
const SEARCHES: { query: string; country: string; remoteOnly?: boolean }[] = [
  { query: "data analyst intern in Prague", country: "cz" },
  { query: "data science internship in Prague", country: "cz" },
  { query: "part time data analyst in Prague", country: "cz" },
  { query: "machine learning AI intern in Prague", country: "cz" },
  { query: "data engineer intern in Prague", country: "cz" },
  { query: "AI automation intern in Prague", country: "cz" },
  { query: "junior python developer part time in Prague", country: "cz" },
  { query: "business intelligence financial analyst intern in Prague", country: "cz" },
  { query: "data science internship", country: "cz", remoteOnly: true },
  { query: "data analyst internship remote Europe", country: "de", remoteOnly: true },
];

const TOP_N = 10;
const MIN_FIT_SCORE = 50;
const MAX_DESCRIPTION_CHARS = 5000;
const CLAUDE_BATCH_SIZE = 10;

const STUDENT_PROFILE = `
- Bachelor student of Data Science at VŠE (Prague University of Economics and Business), 1st-2nd year.
- Lives in Prague, Czech Republic. Non-EU citizen with a Czech student residence permit (students can legally work).
- Languages: English and Spanish. Does NOT speak Czech.
- Skills: Python, SQL, R / statistics, Power BI / Tableau / Excel.
- Interested in: Data Analyst / BI, Data Scientist / ML / AI, Data Engineering, Python development,
  research, business/financial analyst, automation and anything AI-related.
  Roles that offer training/mentoring are a big plus.
- Wants ONLY part-time jobs or internships, and only PAID ones.
- Accepts: on-site in Prague, hybrid in Prague, remote from Czechia, or remote anywhere in the EU.
`;

type JSearchJob = {
  job_id: string;
  job_title: string;
  employer_name: string;
  job_description?: string;
  job_apply_link?: string;
  job_city?: string;
  job_country?: string;
  job_is_remote?: boolean;
  job_employment_type?: string;
  job_posted_at_datetime_utc?: string;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_salary_period?: string | null;
};

const EvaluationSchema = z.object({
  evaluations: z.array(
    z.object({
      id: z.string(),
      czech_required: z.boolean().describe("true only if Czech is mandatory, not just 'an advantage'"),
      job_type: z.enum(["internship", "part_time", "full_time", "other"]),
      paid: z.enum(["yes", "no", "unknown"]),
      eu_citizenship_required: z.boolean(),
      location_ok: z
        .boolean()
        .describe("Prague on-site/hybrid, remote from Czechia, or remote open to EU residents"),
      work_mode: z.enum(["on_site", "hybrid", "remote", "unknown"]),
      fit_score: z.number().describe("0-100, how well it fits the student profile"),
      offers_training: z.boolean(),
      summary_es: z.string().describe("1-2 sentence summary of the job, in Spanish"),
      why_fit_es: z.string().describe("1 sentence on why it fits (or not), in Spanish"),
    }),
  ),
});

type Evaluation = z.infer<typeof EvaluationSchema>["evaluations"][number];

async function searchJobs(
  search: (typeof SEARCHES)[number],
  apiKey: string,
): Promise<JSearchJob[]> {
  const params = new URLSearchParams({
    query: search.query,
    page: "1",
    num_pages: "1",
    country: search.country,
    date_posted: "week",
  });
  if (search.remoteOnly) params.set("work_from_home", "true");

  const res = await fetch(`https://jsearch.p.rapidapi.com/search?${params}`, {
    headers: {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "jsearch.p.rapidapi.com",
    },
  });
  if (!res.ok) {
    throw new Error(`JSearch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: JSearchJob[] };
  return body.data ?? [];
}

// Cheap keyword pre-filter so Claude only reads plausible offers
function passesPreFilter(job: JSearchJob): boolean {
  const title = job.job_title.toLowerCase();
  if (/\b(senior|sr\.?|lead|head|principal|director|manager)\b/.test(title)) return false;

  const description = (job.job_description ?? "").toLowerCase();
  const czechRequired = [
    "czech required",
    "fluent czech",
    "fluent in czech",
    "native czech",
    "czech is a must",
    "czech language is required",
    "znalost češtiny",
    "plynulá čeština",
  ];
  return !czechRequired.some((phrase) => description.includes(phrase));
}

async function evaluateJobs(jobs: JSearchJob[], client: Anthropic): Promise<Evaluation[]> {
  const evaluations: Evaluation[] = [];

  for (let i = 0; i < jobs.length; i += CLAUDE_BATCH_SIZE) {
    const batch = jobs.slice(i, i + CLAUDE_BATCH_SIZE);
    const jobsText = batch
      .map(
        (job) => `<job id="${job.job_id}">
Title: ${job.job_title}
Company: ${job.employer_name}
Location: ${[job.job_city, job.job_country].filter(Boolean).join(", ") || "unknown"} | Remote: ${job.job_is_remote ? "yes" : "no/unknown"}
Employment type: ${job.job_employment_type ?? "unknown"}
Salary: ${job.job_min_salary ?? "?"}-${job.job_max_salary ?? "?"} ${job.job_salary_currency ?? ""} ${job.job_salary_period ?? ""}
Description:
${(job.job_description ?? "").slice(0, MAX_DESCRIPTION_CHARS)}
</job>`,
      )
      .join("\n\n");

    const response = await client.messages.parse({
      model: "claude-haiku-5-5",
      max_tokens: 16000,
      output_config: { effort: "low", format: zodOutputFormat(EvaluationSchema) },
      system: `You screen job offers for a student. Student profile:\n${STUDENT_PROFILE}
Evaluate every job you receive and return one evaluation per job id.
- Czech listed as "advantage" or "nice to have" is NOT required. Job posts written entirely in Czech usually require Czech.
- Paid: "yes" if salary/stipend/hourly pay is mentioned or clearly implied (e.g. a normal company internship in Czechia), "no" if unpaid/voluntary, otherwise "unknown".
- fit_score: high for data/AI/automation roles suited to a 1st-2nd year bachelor; low for unrelated roles or ones needing years of experience.`,
      messages: [{ role: "user", content: jobsText }],
    });

    if (!response.parsed_output) {
      logger.warn("Claude returned no parsed output for a batch", { stop_reason: response.stop_reason });
      continue;
    }
    evaluations.push(...response.parsed_output.evaluations);
  }

  return evaluations;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const WORK_MODE_ES: Record<Evaluation["work_mode"], string> = {
  on_site: "Presencial",
  hybrid: "Híbrido",
  remote: "Remoto",
  unknown: "Modalidad no indicada",
};

const JOB_TYPE_ES: Record<Evaluation["job_type"], string> = {
  internship: "Internship",
  part_time: "Part-time",
  full_time: "Full-time",
  other: "Otro",
};

function buildEmailHtml(picks: { job: JSearchJob; evaluation: Evaluation }[]): string {
  if (picks.length === 0) {
    return `<p>Hola Juan Pablo 👋</p>
<p>Esta semana no hubo ofertas nuevas que cumplan todos tus requisitos (part-time/internship pagada, sin checo, relacionada con datos/IA). La automatización funcionó bien; el lunes que viene vuelvo a buscar.</p>`;
  }

  const items = picks
    .map(({ job, evaluation }, index) => {
      const place = [job.job_city, job.job_country].filter(Boolean).join(", ");
      const paid = evaluation.paid === "yes" ? "Pagada" : "No indica salario";
      const training = evaluation.offers_training ? " · 🎓 Ofrece formación" : "";
      const link = job.job_apply_link
        ? `<a href="${escapeHtml(job.job_apply_link)}" style="color:#2563eb;font-weight:600;">Ver oferta y aplicar →</a>`
        : "";
      return `<div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px;">
  <div style="font-size:12px;color:#6b7280;">#${index + 1} · Encaje ${Math.round(evaluation.fit_score)}/100</div>
  <div style="font-size:17px;font-weight:700;margin:4px 0;">${escapeHtml(job.job_title)}</div>
  <div style="color:#374151;">${escapeHtml(job.employer_name)}${place ? ` · ${escapeHtml(place)}` : ""}</div>
  <div style="font-size:13px;color:#6b7280;margin:6px 0;">${JOB_TYPE_ES[evaluation.job_type]} · ${WORK_MODE_ES[evaluation.work_mode]} · ${paid}${training}</div>
  <p style="margin:8px 0;">${escapeHtml(evaluation.summary_es)}</p>
  <p style="margin:8px 0;color:#065f46;"><b>Por qué encaja:</b> ${escapeHtml(evaluation.why_fit_es)}</p>
  ${link}
</div>`;
    })
    .join("\n");

  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827;">
<p>Hola Juan Pablo 👋</p>
<p>Estas son las ${picks.length} mejores ofertas de la semana para tu perfil (part-time o internship, sin checo, relacionadas con datos e IA):</p>
${items}
<p style="font-size:12px;color:#9ca3af;">Solo se incluyen ofertas publicadas en los últimos 7 días. Revisa siempre los requisitos antes de aplicar.</p>
</div>`;
}

async function sendEmail(apiKey: string, to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Ofertas de trabajo <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export const weeklyStudentJobs = schedules.task({
  id: "weekly-student-jobs",
  cron: { pattern: "0 8 * * 1", timezone: "Europe/Prague" }, // every Monday 8:00 Prague time
  run: async () => {
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!rapidApiKey) throw new Error("RAPIDAPI_KEY is not set");
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) throw new Error("RESEND_API_KEY is not set");
    const alertEmail = process.env.JOB_ALERT_EMAIL;
    if (!alertEmail) throw new Error("JOB_ALERT_EMAIL is not set");

    // 1. Search (a failing query is skipped; if all fail, the run fails and retries)
    const found = new Map<string, JSearchJob>();
    const seenTitleCompany = new Set<string>();
    let failedSearches = 0;
    for (const search of SEARCHES) {
      try {
        const jobs = await searchJobs(search, rapidApiKey);
        for (const job of jobs) {
          const titleCompany = `${job.job_title}|${job.employer_name}`.toLowerCase();
          if (found.has(job.job_id) || seenTitleCompany.has(titleCompany)) continue;
          found.set(job.job_id, job);
          seenTitleCompany.add(titleCompany);
        }
        logger.info(`Search "${search.query}" → ${jobs.length} jobs`);
      } catch (error) {
        failedSearches++;
        logger.error(`Search "${search.query}" failed`, { error: String(error) });
      }
    }
    if (failedSearches === SEARCHES.length) {
      throw new Error("All JSearch queries failed");
    }

    // 2. Pre-filter by keywords
    const candidates = [...found.values()].filter(passesPreFilter);
    logger.info("Candidates", { unique: found.size, afterPreFilter: candidates.length });

    // 3. Claude evaluates each candidate
    const client = new Anthropic({ apiKey: anthropicApiKey });
    const evaluations = candidates.length > 0 ? await evaluateJobs(candidates, client) : [];

    // 4. Keep only offers that meet every requirement, best fit first
    const picks = evaluations
      .filter(
        (e) =>
          !e.czech_required &&
          (e.job_type === "internship" || e.job_type === "part_time") &&
          e.paid !== "no" &&
          !e.eu_citizenship_required &&
          e.location_ok &&
          e.fit_score >= MIN_FIT_SCORE,
      )
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, TOP_N)
      .flatMap((evaluation) => {
        const job = found.get(evaluation.id);
        return job ? [{ job, evaluation }] : [];
      });

    // 5. Send the email (also when there are no picks, so you know it ran)
    const date = new Date().toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: "Europe/Prague" });
    const subject =
      picks.length > 0
        ? `💼 ${picks.length} ofertas de trabajo para ti · semana del ${date}`
        : `💼 Sin ofertas nuevas esta semana · ${date}`;
    await sendEmail(resendApiKey, alertEmail, subject, buildEmailHtml(picks));

    return {
      jobsFound: found.size,
      afterPreFilter: candidates.length,
      evaluated: evaluations.length,
      sent: picks.length,
      failedSearches,
    };
  },
});
