// Turn an agy process result (exit code, stdout envelope, stderr) into a
// single outcome. Classifiers match stderr + the envelope's `error` field, not
// the model's reply text (a reply may legitimately talk about "quota"). The one
// exception is agy's fixed safety-filter notice, which agy returns as a
// "successful" response.

export const OUTCOMES = {
  success: { exit: 0, label: "completed" },
  error: { exit: 1, label: "agy error" },
  not_installed: { exit: 3, label: "agy not installed" },
  quota: { exit: 10, label: "quota / rate limit" },
  auth: { exit: 11, label: "authentication required" },
  timeout: { exit: 12, label: "timed out" },
  denied: { exit: 13, label: "stopped by permission policy" },
  model_unavailable: { exit: 14, label: "model unavailable" },
  cancelled: { exit: 15, label: "cancelled" },
  empty: { exit: 16, label: "empty response" },
  invalid_output: { exit: 17, label: "invalid structured output" },
  filtered: { exit: 18, label: "blocked by Gemini safety filter" }
};

const MODEL_RE = [
  /is not recognized as a known model/i,
  /not a known model/i,
  /invalid (--)?model/i,
  /invalid model selection/i,
  /model \S+ is (currently )?(unavailable|no longer available)/i,
  /model was not found, or your project does not have access/i,
  /model is not supported in the selected location/i
];
const QUOTA_RE = [
  /\bquota\b/i,
  /rate[ -]?limit/i,
  /resource[ _]exhausted/i,
  /credits? balance is too low/i,
  /insufficient credits/i,
  /spend cap/i,
  /monetization_denied/i,
  /individual quota reached/i,
  /\bstatus(code)?[ =:]*429\b/i
];
const AUTH_RE = [
  /\bunauthenticated\b/i,
  /authentication (required|failed|timed out)/i,
  /please (sign in|authenticate|log ?in)/i,
  /\breauth(enticate|orization required)/i,
  /gemini_api_key environment variable is not set/i,
  /eligibility check failed/i
];
const TIMEOUT_RE = [
  /print timeout after \S+ with (the )?turn (still )?in progress/i,
  /print timeout after \S+ with \d+ background task/i,
  /"reason"\s*:\s*"print_timeout"/i,
  /timeout waiting for cascade/i
];
const FILTER_RE = /^\s*This request was blocked by Gemini's filters\b/;
const FILTER_REASON_RE = /^(finish_reason_)?(safety|prohibited_content|recitation|blocklist|spii)$/i;
const FILTER_NOTICE_ERROR =
  "Gemini's safety filter blocked this request (agy returned its standard filter notice instead of an answer). Rephrase the task, e.g. avoid wording that reads like an attack or exploit.";

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** agy's result envelope always has a status plus a response or conversation id; other JSON (e.g. a child's output) doesn't count. */
function isEnvelopeObject(v) {
  return isPlainObject(v) && typeof v.status === "string" && ("response" in v || "conversation_id" in v);
}

function extractBalancedObject(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { slice: text.slice(start, i + 1), end: i };
    }
  }
  return null;
}

/**
 * Lenient envelope parse. agy has emitted raw control characters inside JSON
 * strings and printed diagnostics before or after the JSON; handle both without
 * touching structural whitespace.
 */
export function parseEnvelope(stdoutText) {
  const text = String(stdoutText ?? "").trim();
  if (!text) return null;
  const attempt = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      try {
        return JSON.parse(escapeControlCharsInStrings(t));
      } catch {
        return null;
      }
    }
  };
  let obj = attempt(text);
  if (isPlainObject(obj)) return obj;
  // Diagnostics before or after the JSON: scan balanced objects starting at each `{` line.
  let lastEnvelope = null;
  let lastObj = null;
  let pos = text.startsWith("{") ? 0 : text.indexOf("\n{");
  while (pos !== -1) {
    const start = text[pos] === "{" ? pos : pos + 1;
    const match = extractBalancedObject(text, start);
    if (match) {
      obj = attempt(match.slice);
      if (isPlainObject(obj)) {
        lastObj = obj;
        if (isEnvelopeObject(obj)) lastEnvelope = obj;
        pos = text.indexOf("\n{", match.end + 1);
        continue;
      }
    }
    pos = text.indexOf("\n{", start + 1);
  }
  return lastEnvelope ?? lastObj;
}

function escapeControlCharsInStrings(t) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) {
        esc = false;
        out += ch;
      } else if (ch === "\\") {
        esc = true;
        out += ch;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch.charCodeAt(0) < 0x20) {
        out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function anyMatch(res, text) {
  return res.some((re) => re.test(text));
}

const REVIEW_SEVERITIES = new Set(["critical", "high", "medium", "low"]);

/** Structural check for the review schema (schemas/review-output.schema.json). */
export function validateReview(s) {
  if (!isPlainObject(s)) return "no structured output";
  if (!["approve", "needs-attention"].includes(s.verdict)) return "missing or invalid verdict";
  if (typeof s.summary !== "string" || !s.summary.trim()) return "missing summary";
  if (!Array.isArray(s.findings)) return "missing findings array";
  for (const f of s.findings) {
    if (!isPlainObject(f)) return "malformed finding";
    if (!REVIEW_SEVERITIES.has(f.severity)) return "invalid finding severity";
    if (typeof f.title !== "string" || !f.title.trim()) return "missing finding title";
    if (typeof f.body !== "string" || !f.body.trim()) return "missing finding body";
    if (typeof f.file !== "string" || !f.file.trim()) return "missing finding file";
    if (!Number.isInteger(f.line_start) || f.line_start < 1) return "invalid finding line_start";
    if (!Number.isInteger(f.line_end) || f.line_end < 1) return "invalid finding line_end";
    if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) {
      return "invalid finding confidence";
    }
    if (typeof f.recommendation !== "string") return "missing finding recommendation";
  }
  if (!Array.isArray(s.next_steps) || !s.next_steps.every((n) => typeof n === "string" && n.trim().length > 0)) {
    return "missing or invalid next_steps";
  }
  return null;
}

function stringifyEnvError(err) {
  if (err == null || err === false) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function deniedMessage(deniedActions, envError = "") {
  const list = deniedActions.map((a) => `${a?.action ?? String(a)}${a?.display_name ? ` / ${a.display_name}` : ""}`).join(", ");
  const base = `The run ended when agy needed a permission this policy does not grant (${list}).`;
  return envError ? `${base} ${firstLine(envError)}` : base;
}

/**
 * Classify a completed agy process result into an OUTCOMES key and structured metadata.
 * @param {{exitCode:number|null, signal?:string|null, stdout:string, stderr:string,
 *          guardFired?:boolean, cancelled?:boolean, schemaRequested?:boolean}} r
 */
export function classifyRun(r) {
  const envelope = parseEnvelope(r.stdout);
  const warnings = [];
  const response = typeof envelope?.response === "string" ? envelope.response : "";
  const structured = envelope?.structured_output ?? null;
  const deniedActions = Array.isArray(envelope?.denied_actions) ? envelope.denied_actions : [];
  const envError = stringifyEnvError(envelope?.error);
  const stderr = String(r.stderr ?? "");
  const diag = `${stderr}\n${envError}`;
  const finishedReason = envelope?.finished_reason || "";
  const hasAnswer = response.trim().length > 0 || structured != null;

  const result = (outcome, error = null) => ({ outcome, envelope, response, structured, error, warnings, deniedActions, partial: outcome !== "success" && hasAnswer });

  if (r.cancelled) return result("cancelled", "Cancelled.");

  const timeoutEvidence = finishedReason === "print_timeout" || anyMatch(TIMEOUT_RE, diag);
  const benignFinish = !finishedReason || /^(stop|end_turn|completed|success)$/i.test(finishedReason);

  // agy 1.4.x bug: prints a complete result, then never exits. Only trust it if
  // nothing suggests the turn was cut short.
  if (r.guardFired) {
    if (envelope?.status === "SUCCESS" && hasAnswer && benignFinish && !envError && !timeoutEvidence) {
      warnings.push("agy did not exit after finishing; it was stopped by the wall-clock guard. The answer looked complete.");
    } else {
      return result("timeout", "agy exceeded the wall-clock limit and was stopped.");
    }
  } else if (r.exitCode == null && !envelope) {
    const detail = !r.signal ? lastLines(stderr, 3) : "";
    return result("error", detail || `agy was terminated (${r.signal ?? "unknown signal"}) before producing output.`);
  }

  const clean = r.guardFired || (r.exitCode === 0 && !r.signal);
  const failed = !clean || (envelope && envelope.status !== "SUCCESS") || !!envError || !benignFinish;

  if (failed) {
    const matchDetail = (res) => matchingLine(res, envError) || matchingLine(res, stderr) || firstLine(envError) || firstLine(stderr);
    if (anyMatch(MODEL_RE, diag)) return result("model_unavailable", matchDetail(MODEL_RE));
    if (timeoutEvidence) return result("timeout", firstLine(envError) || "agy print timeout reached; the response is partial or missing.");
    if (anyMatch(AUTH_RE, diag)) return result("auth", matchDetail(AUTH_RE));
    if (anyMatch(QUOTA_RE, diag)) return result("quota", matchDetail(QUOTA_RE));
    if (FILTER_RE.test(response)) return result("filtered", FILTER_NOTICE_ERROR);
    if (FILTER_REASON_RE.test(finishedReason)) {
      return result("filtered", `Gemini's safety filter blocked this request (${finishedReason}).${envError ? ` ${firstLine(envError)}` : ""}`);
    }
    if (deniedActions.length) return result("denied", deniedMessage(deniedActions, envError));
    if (!benignFinish) return result("error", `agy stopped early (${finishedReason}).${envError ? ` ${firstLine(envError)}` : ""}`);
    const exitDetail = r.exitCode != null ? `agy exited with code ${r.exitCode}.` : `agy was terminated (${r.signal ?? "unknown signal"}).`;
    return result("error", firstLine(envError) || lastLines(stderr, 3) || exitDetail);
  }

  if (!envelope) return result("empty", "agy exited 0 without producing a JSON result.");

  if (FILTER_RE.test(response)) {
    return result("filtered", FILTER_NOTICE_ERROR);
  }

  if (!hasAnswer) {
    if (deniedActions.length) {
      return result("denied", deniedMessage(deniedActions));
    }
    return result("empty", "agy reported success but returned no response.");
  }

  if (r.schemaRequested) {
    const problem = validateReview(structured);
    if (problem) return result("invalid_output", `The model's review did not match the required schema (${problem}).`);
  }

  if (deniedActions.length) {
    warnings.push(`Some actions were denied by policy: ${deniedActions.map((a) => a?.action ?? String(a)).join(", ")}.`);
  }
  return result("success");
}

function firstLine(s) {
  const line = String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

function matchingLine(res, s) {
  const line = String(s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && anyMatch(res, l));
  return line ?? "";
}

/** Return the last `n` non-empty lines of `s`, with trailing whitespace trimmed. */
export function lastLines(s, n) {
  if (n <= 0) return "";
  return String(s ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-n)
    .join("\n");
}

/** Extract the "Available models:" block agy prints on an invalid --model. */
export function parseAvailableModels(text) {
  const s = String(text ?? "");
  const idx = s.indexOf("Available models:");
  if (idx === -1) return [];
  return s
    .slice(idx + "Available models:".length)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[A-Z_]+:/.test(l))
    .slice(0, 60);
}
