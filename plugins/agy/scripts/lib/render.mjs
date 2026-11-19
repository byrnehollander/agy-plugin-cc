// Markdown rendering for everything the companion prints.

import { formatDuration } from "./args.mjs";
import { OUTCOMES, lastLines, parseAvailableModels } from "./classify.mjs";

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function fmtTokens(n) {
  if (n == null) return "?";
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Render the compact metadata footer appended to task, review, and failure reports. */
export function footer({ job, envelope, durationMs }) {
  const u = envelope?.usage ?? {};
  const bits = [
    `job \`${job.id}\``,
    `\`${job.model}\``,
    job.policyLabel,
    formatDuration(durationMs ?? (envelope?.duration_seconds != null ? envelope.duration_seconds * 1000 : null)),
    u.total_tokens != null
      ? `${fmtTokens(u.total_tokens)} tokens (${fmtTokens(u.output_tokens)} out, ${fmtTokens(u.thinking_tokens)} thinking)`
      : null,
    envelope?.conversation_id ? `conversation \`${envelope.conversation_id}\`` : null
  ].filter(Boolean);
  return `\n---\n<sub>${bits.join(" · ")}</sub>\n`;
}

function hintFor(outcome, job, classified) {
  switch (outcome) {
    case "auth":
      return "Sign in once interactively: open the Antigravity app, or run `! agy` in this session and complete the Google login, then retry. `/agy:setup` checks the state.";
    case "quota":
      return "The Antigravity plan's quota or rate limit was hit. Wait and retry, or use a cheaper model (`--effort low`, `--model hydrogen`). Run `agy` interactively and use `/usage` to see remaining quota.";
    case "timeout":
      return job.background || job.long
        ? "Retry with a longer `--timeout`, or narrow the task."
        : "Retry with `--background` (no 10-minute limit) and/or a longer `--timeout`, or narrow the task.";
    case "model_unavailable": {
      const avail = parseAvailableModels(`${classified.envelope?.error ?? ""}\n${classified.stderr ?? ""}`);
      const list = avail.length ? `\nAvailable on this account:\n${avail.map((m) => `- ${m}`).join("\n")}` : "";
      return `Pick another model with \`--model\` (aliases: neon, argon, hydrogen, flash, orchestrator; effort via \`--effort low|medium|high|xhigh\`).${list}`;
    }
    case "denied":
      if (job.mode === "shell" && job.allowCommands?.length) {
        return "The model needed a command outside the `--allow-command` list, or a write outside the workspace / into a protected path. Add the command prefix (if you trust it) or narrow the task.";
      }
      return job.mode === "write" || job.mode === "shell"
        ? "The model tried to write outside the workspace or into a protected path (.git, .claude, ...), which ends the run. Narrow the task or make that change yourself."
        : "The model needed a permission the read-only policy does not grant. If edits were intended, rerun with `--write` (edit files) or `--shell` (edit files and run commands in the sandbox).";
    case "not_installed":
      return "Run `/agy:setup` to install and verify the Antigravity CLI.";
    case "empty":
      return "Retry once; if it repeats, check the stderr excerpt below and `/agy:setup`.";
    case "invalid_output":
      return "Retry the review; if it repeats, try `--effort high` or another model.";
    case "filtered":
      return "Rephrase the request in neutral terms (e.g. describe the code's behaviour rather than an attack), then retry.";
    default:
      return "See the stderr excerpt below. `/agy:setup` verifies the installation.";
  }
}

/** Render a failed agy run with diagnosis, next step, optional partial output, and stderr tail. */
export function renderFailure({ job, classified, stderr, durationMs, changes }) {
  const label = OUTCOMES[classified.outcome]?.label ?? classified.outcome;
  const lines = [`## agy run failed: ${label}`, "", classified.error ?? "Unknown error.", "", `**Next step:** ${hintFor(classified.outcome, job, { ...classified, stderr })}`];
  if (classified.partial && classified.response?.trim()) {
    lines.push("", "<details><summary>Partial response (incomplete; do not rely on it)</summary>", "", classified.response.trim(), "", "</details>");
  }
  if (changes && changes.files.length) lines.push("", renderChanges(changes));
  const tail = lastLines(stderr, 8);
  if (tail && !["model_unavailable", "cancelled"].includes(classified.outcome)) {
    lines.push("", "<details><summary>stderr (last lines)</summary>", "", "```", tail, "```", "", "</details>");
  }
  if (classified.warnings?.length) {
    lines.push("", ...classified.warnings.map((w) => `> ⚠️ ${w}`));
  }
  lines.push(footer({ job, envelope: classified.envelope, durationMs }));
  return lines.join("\n");
}

/** Render a completed task run report. */
export function renderTask({ job, classified, durationMs, changes }) {
  const out = [];
  out.push(`## ${job.modelLabel ?? job.model} (via Antigravity)`);
  out.push("");
  out.push(classified.response.trim() || "_(no text response)_");
  if (classified.warnings.length) {
    out.push("", ...classified.warnings.map((w) => `> ⚠️ ${w}`));
  }
  if ((job.mode === "write" || job.mode === "shell")) out.push("", renderChanges(changes));
  out.push(footer({ job, envelope: classified.envelope, durationMs }));
  return out.join("\n");
}

/** Render the post-run changed-files audit section for write-mode jobs. */
export function renderChanges(changes) {
  if (!changes) return "";
  const sensitiveSet = new Set(changes.sensitive);
  const lines = ["### Files changed by this run"];
  if (!changes.files.length) {
    lines.push("", "_No files changed._");
  } else {
    lines.push("");
    for (const f of changes.files) {
      const flag = sensitiveSet.has(f.file) ? " ⚠️ **protected path**" : "";
      lines.push(`- \`${f.file}\` (${f.change})${flag}`);
    }
  }
  if (changes.incomplete) lines.push("", "> ⚠️ The change scan hit its time budget; the list may be incomplete. Check `git status`.");
  if (changes.sensitive.length) {
    lines.push("", "> ⚠️ **A protected path changed** (" + changes.sensitive.map((f) => `\`${f}\``).join(", ") + "). Inspect it before running anything in this repo, especially git hooks.");
  }
  lines.push("", changes.shell ? "Review with `git diff` before keeping these changes." : "Review with `git diff` before keeping these changes. The model could not run tests or builds.");
  return lines.join("\n");
}

/** Render a structured (or fallback raw) review or adversarial-review report. */
export function renderReview({ job, classified, durationMs, target, context }) {
  const s = classified.structured;
  const out = [];
  const title = job.kind === "adversarial-review" ? "Adversarial review" : "Review";
  if (!s || typeof s !== "object" || !Array.isArray(s.findings)) {
    out.push(`## ${title} by ${job.modelLabel ?? job.model}`, "", "> ⚠️ The model did not return structured output; showing its raw response.", "", classified.response.trim() || "_(empty)_");
    out.push(footer({ job, envelope: classified.envelope, durationMs }));
    return out.join("\n");
  }
  const verdict = s.verdict === "approve" ? "✅ approve" : "⚠️ needs attention";
  out.push(`## ${title} by ${job.modelLabel ?? job.model}: ${verdict}`);
  out.push("", `**Target:** ${target.label}${context?.truncated ? " _(diff truncated; the model read files directly for the rest)_" : ""}`);
  out.push("", s.summary);
  const findings = [...s.findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || (b.confidence ?? 0) - (a.confidence ?? 0)
  );
  if (!findings.length) {
    out.push("", "No material findings.");
  } else {
    out.push("", `### Findings (${findings.length})`);
    findings.forEach((f, i) => {
      const loc =
        f.line_start == null
          ? f.file
          : f.line_end && f.line_end !== f.line_start
            ? `${f.file}:${f.line_start}-${f.line_end}`
            : `${f.file}:${f.line_start}`;
      out.push(
        "",
        `**${i + 1}. [${String(f.severity ?? "unknown").toUpperCase()}] ${f.title}**  `,
        `\`${loc}\` · confidence ${Number(f.confidence ?? 0).toFixed(2)}`,
        "",
        f.body ?? "",
        "",
        f.recommendation ? `**Recommendation:** ${f.recommendation}` : ""
      );
    });
  }
  if (Array.isArray(s.next_steps) && s.next_steps.length) {
    out.push("", "### Next steps", ...s.next_steps.map((n) => `- ${n}`));
  }
  if (classified.warnings.length) out.push("", ...classified.warnings.map((w) => `> ⚠️ ${w}`));
  out.push(footer({ job, envelope: classified.envelope, durationMs }));
  return out.join("\n");
}

/** Render a Markdown status table for workspace jobs. */
export function renderStatus(jobs, { all = false } = {}) {
  const shown = all ? jobs : jobs.slice(0, 10);
  if (!shown.length) return "No agy jobs recorded for this workspace yet.";
  const rows = [
    "| Job | Kind | Status | Model | Mode | Started | Duration | Summary |",
    "|---|---|---|---|---|---|---|---|"
  ];
  for (const j of shown) {
    const started = j.startedAt ?? j.createdAt;
    const startedMs = started ? Date.parse(started) : Number.NaN;
    const startedLabel = Number.isFinite(startedMs) ? new Date(startedMs).toLocaleString() : "-";
    const dur = j.finishedAt
      ? formatDuration(Date.parse(j.finishedAt) - startedMs)
      : j.status === "running"
        ? `${formatDuration(Date.now() - startedMs)} (running)`
        : "-";
    const summary = String(j.summary ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 70);
    rows.push(
      `| \`${j.id}\` | ${j.kind} | ${statusIcon(j.status, j.outcome)} | ${j.model ?? "-"} | ${j.mode ?? "-"} | ${startedLabel} | ${dur} | ${summary} |`
    );
  }
  const lines = [rows.join("\n")];
  if (!all && jobs.length > shown.length) lines.push("", `_${jobs.length - shown.length} older job(s) hidden; use \`--all\`._`);
  lines.push("", "Full output: `/agy:result <job>` · Stop a running job: `/agy:cancel <job>`");
  return lines.join("\n");
}

function statusIcon(status, outcome) {
  if (status === "completed") return "✅ completed";
  if (status === "failed") return `❌ ${OUTCOMES[outcome]?.label ?? "failed"}`;
  if (status === "cancelled") return "⏹ cancelled";
  if (status === "running") return "⏳ running";
  if (status === "queued") return "⏳ queued";
  if (status === "lost") return "❓ lost";
  return status;
}
