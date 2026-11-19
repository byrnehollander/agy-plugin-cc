---
name: agy-result-handling
description: How to present output from the agy plugin (Gemini 4 Neon via the Antigravity CLI) back to the user. Applies after /agy:rescue, /agy:review, /agy:adversarial-review, /agy:result, or the agy-rescue subagent.
user-invocable: false
---

# Presenting agy output

- Show the companion's Markdown verbatim. Keep its headings, verdict, findings order (already sorted by severity), file paths, line numbers, confidence values and the footer line.
- Keep evidence boundaries: if Neon marked something as an inference, uncertain, or unverified, do not present it as fact.
- If there are no findings, say so in one line.
- If the run used `--write` or `--shell`, point out the "Files changed by this run" list and remind the user to review `git diff`. After `--write` (no commands), offer to run the verification commands Neon suggested, but only after the user agrees. After `--shell`, say which commands Neon reports it ran and their results; still verify independently before claiming success.
- Surface any "Network blocked by the egress policy" or "agentapi shim" warning verbatim.
- Any ⚠️ "protected path" warning is a priority: tell the user before anything else and do not run code from the repo until they have looked.

After a review:
- STOP after presenting the findings. Do not edit files or apply fixes. Ask the user which findings, if any, they want addressed.

After a failure (heading "agy run failed"):
- Show the failure and its **Next step** line, then stop. Do not retry automatically with different flags, and never answer the original question yourself as a substitute for Neon's answer.

When comparing with Codex or Claude:
- Review output uses the same fields as `/codex:review` (verdict, summary, findings with severity/file/lines/confidence/recommendation, next_steps), so findings can be lined up side by side. Attribute each finding to the model that produced it.
