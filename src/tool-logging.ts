/**
 * Structured logging wrapper for MCP tool handlers.
 *
 * Every tool logs start (name + arg summary), and end (duration + ok/err).
 * Large string fields (like base64 blobs) are redacted to a length marker so
 * logs stay small and don't expose receipt bytes.
 */

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
 * Wrap an async tool body. Logs start/finish, serializes the result as the
 * MCP text response, and turns thrown errors into isError responses while
 * logging the full error (with stack) to stderr.
 */
export async function runTool<A, R>(
  name: string,
  args: A,
  fn: (args: A) => Promise<R>,
): Promise<ToolResult> {
  const start = Date.now();
  console.error(`[tool] ${name} start args=${summarizeArgs(args)}`);
  try {
    const result = await fn(args);
    const duration = Date.now() - start;
    console.error(`[tool] ${name} ok duration=${duration}ms`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
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
