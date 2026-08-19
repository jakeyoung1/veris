// Turn a raw SEC filing into a sentence a human acts on.
//
// This is the layer that separates veris from a free EDGAR RSS feed. RSS tells
// you a document exists. This says what changed and why it matters — and, per
// the provenance thesis, every claim carries a verbatim quote from the filing
// so the reader can check it instead of trusting us.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4"; // v4 API (shipped inside zod 3.25) — required by zodOutputFormat
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { FilingRef } from "./edgar.js";
import { formLabel } from "./materiality.js";

/** Chars of filing text sent to the model. ~250k chars ≈ 60k tokens. */
const CHAR_BUDGET = Number(process.env.VERIS_SUMMARY_CHAR_BUDGET ?? 250_000);

const MODEL = process.env.VERIS_SUMMARY_MODEL ?? "claude-opus-5";

export const FilingSummarySchema = z.object({
  headline: z
    .string()
    .describe(
      "One sentence, under 120 chars, stating the single most important thing " +
        "in this filing. Written for a busy analyst. No preamble, no 'The company announced'.",
    ),
  whatChanged: z
    .array(z.string())
    .describe(
      "1-4 bullets of concrete, specific facts from this filing: names, dollar " +
        "amounts, dates, percentages. No generalities.",
    ),
  whyItMatters: z
    .string()
    .describe(
      "One or two sentences on the consequence for an investor or compliance " +
        "reader. If it is genuinely routine, say so plainly.",
    ),
  materiality: z
    .enum(["high", "medium", "low"])
    .describe(
      "high = moves the stock or triggers an obligation (M&A, guidance change, " +
        "executive departure, restatement, litigation, going concern). " +
        "medium = notable but not urgent. low = routine/administrative.",
    ),
  evidence: z
    .array(z.string())
    .describe(
      "1-3 short verbatim quotes copied exactly from the filing text that " +
        "support the claims above. Must appear in the source character-for-character.",
    ),
});

export type FilingSummary = z.infer<typeof FilingSummarySchema>;

export interface SummaryResult extends FilingSummary {
  model: string;
  /** True when the filing exceeded CHAR_BUDGET and only the opening was read. */
  truncated: boolean;
  charsRead: number;
  charsTotal: number;
  /** Quotes that could NOT be found verbatim in the source (possible hallucination). */
  unverifiedQuotes: string[];
}

export class MissingCredentialsError extends Error {
  constructor() {
    super(
      "No Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) " +
        "to enable filing summaries. Without it veris still sends raw filing alerts.",
    );
    this.name = "MissingCredentialsError";
  }
}

export function summariesEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Normalize whitespace so quote verification isn't defeated by line wrapping. */
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Summarize one filing. Throws MissingCredentialsError if no key is configured
 * — callers should fall back to a raw alert rather than dropping the notice.
 */
export async function summarizeFiling(
  filing: FilingRef,
  company: string,
  filingText: string,
): Promise<SummaryResult> {
  if (!summariesEnabled()) throw new MissingCredentialsError();

  const charsTotal = filingText.length;
  const truncated = charsTotal > CHAR_BUDGET;
  const body = truncated ? filingText.slice(0, CHAR_BUDGET) : filingText;

  const client = new Anthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system:
      "You read SEC filings for a compliance and investment audience. You are " +
      "precise and you never speculate. Every claim you make must be supported " +
      "by text actually present in the filing. If the filing is routine, say it " +
      "is routine — do not manufacture significance. Quotes in `evidence` must be " +
      "copied verbatim from the filing, not paraphrased.",
    messages: [
      {
        role: "user",
        content:
          `Company: ${company}\n` +
          `Form: ${filing.form} (${formLabel(filing.form)})\n` +
          `Filed: ${filing.filingDate}\n` +
          `Source: ${filing.docUrl}\n` +
          (truncated
            ? `\nNOTE: this filing is ${charsTotal.toLocaleString()} characters; ` +
              `you are seeing the first ${CHAR_BUDGET.toLocaleString()}. ` +
              `Summarize only what is present below and do not guess at the rest.\n`
            : "") +
          `\n--- FILING TEXT ---\n${body}`,
      },
    ],
    output_config: { format: zodOutputFormat(FilingSummarySchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      `Summary parse failed for ${company} ${filing.form} (${filing.accession})`,
    );
  }

  // Verify each quote actually appears in what we sent the model. A quote that
  // doesn't is the one failure mode that would poison a provenance product.
  const haystack = norm(body);
  const unverifiedQuotes = parsed.evidence.filter(
    (q) => q.trim().length > 0 && !haystack.includes(norm(q)),
  );

  return {
    ...parsed,
    model: MODEL,
    truncated,
    charsRead: body.length,
    charsTotal,
    unverifiedQuotes,
  };
}
