/**
 * The single response path for every MCP tool handler: logging, serialization
 * and the result-size budget in one place.
 *
 * A handler returns plain data (or a ready-made string) and this turns it into
 * the MCP text response. Two things are therefore true by default, for every
 * tool, including ones written later:
 *
 *  - results are serialized with `compact()` — no pretty-printing, which alone
 *    was ~25% of a payload;
 *  - a result over `MAX_RESULT_CHARS` is a named error naming the size, never
 *    an oversized payload that fails past our edge as "the tool errored".
 *
 * Tools that can be large still page (`packRows`) so the answer fits; the
 * budget here is the backstop that makes forgetting to page visible.
 *
 * Every tool logs start (name + arg summary) and end (duration, size, ok/err).
 * Large string fields (like base64 blobs) are redacted to a length marker so
 * logs stay small and don't expose receipt bytes.
 */

import { MAX_RESULT_CHARS, compact, overBudget } from "./result-size.js";

const REDACT_STRING_LEN = 200;

function summarizeArgs(args: unknown): string {
  if (args == null) return "{}";
  if (typeof args !== "object") return JSON.stringify(args);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > REDACT_STRING_LEN) {
      out[k] = `<string len=${v.length}>`;
    } else {
      out[k] = v;
    }
  }
  try {
    return JSON.stringify(out);
  } catch {
    return "<unserializable>";
  }
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Return this from a handler when the payload is data AND a failure — a batch
 * where every item failed reports each item's error, so throwing would lose
 * the detail. Keeps such results on the same serialize-and-budget path.
 */
export class ToolFailure<T = unknown> {
  constructor(readonly data: T) {}
}

export interface RunToolOptions {
  /**
   * What to tell the caller when this tool's result is over budget — the
   * sentence naming THIS tool's paging knobs (see `src/tools/list-paging.ts`).
   * Omitted means the knob-free default: a tool with no paging arguments has
   * none to name, and naming another tool's is worse than naming none.
   */
  narrowing?: string;
}

/**
 * Wrap an async tool body. Logs start/finish, serializes the result as the
 * MCP text response (compact, and refused if over the result-size budget),
 * and turns thrown errors into isError responses while logging the full error
 * (with stack) to stderr.
 *
 * A handler may return a string to control the text itself (the reconcile
 * worksheet's human-readable listing does); it is still budget-checked.
 */
export async function runTool<A, R>(
  name: string,
  args: A,
  fn: (args: A) => Promise<R>,
  { narrowing }: RunToolOptions = {},
): Promise<ToolResult> {
  const start = Date.now();
  console.error(`[tool] ${name} start args=${summarizeArgs(args)}`);
  try {
    const result = await fn(args);
    const duration = Date.now() - start;
    const failed = result instanceof ToolFailure;
    const payload = failed ? result.data : result;
    const text = typeof payload === "string" ? payload : compact(payload);
    if (text.length > MAX_RESULT_CHARS) {
      console.error(
        `[tool] ${name} over-budget duration=${duration}ms chars=${text.length} budget=${MAX_RESULT_CHARS}`,
      );
      return {
        content: [{ type: "text", text: `Error: ${overBudget(name, text.length, narrowing)}` }],
        isError: true,
      };
    }
    console.error(
      `[tool] ${name} ${failed ? "failed" : "ok"} duration=${duration}ms chars=${text.length}`,
    );
    return { content: [{ type: "text", text }], ...(failed ? { isError: true } : {}) };
  } catch (err) {
    const duration = Date.now() - start;
    const e = err as Error;
    console.error(
      `[tool] ${name} error duration=${duration}ms msg=${e.message}\n${e.stack ?? ""}`,
    );
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
}
