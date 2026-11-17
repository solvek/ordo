// Lines of a session transcript. Secrets that look like keys are cut before a line is stored.
const TOOL_CAP = 8000;

export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/(ANTHROPIC_API_KEY=)\S+/g, "$1…")
    .replace(/(Bearer )\S+/gi, "$1…")
    .replace(/(\/bot)\d+:[A-Za-z0-9_-]+/g, "$1…");
}

/** One line per source line, each marked with `prefix`. */
export function prefixed(prefix: string, text: string): string[] {
  const body = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (body === "") return [`${prefix}: (empty)`];
  return body.split("\n").map((line) => `${prefix}: ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolJson(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = "(not serializable)";
  }
  if (text.length <= TOOL_CAP) return text;
  return `${text.slice(0, TOOL_CAP)} …(${String(text.length - TOOL_CAP)} more characters)`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return toolJson(content);
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
    else parts.push(toolJson(block));
  }
  return parts.join("\n");
}

/** What one message content (a string or a list of blocks) contributes to the transcript. */
export function contentLines(content: unknown): string[] {
  if (typeof content === "string") return prefixed("text", content);
  if (!Array.isArray(content)) return ["content: (none)"];
  const lines: string[] = [];
  for (const block of content) lines.push(...blockLines(block));
  return lines.length === 0 ? ["content: (empty)"] : lines;
}

function blockLines(block: unknown): string[] {
  if (!isRecord(block)) return ["block: (not an object)"];
  const type = typeof block.type === "string" ? block.type : "block";
  if (type === "text" && typeof block.text === "string") return prefixed("text", block.text);
  if (type === "thinking" && typeof block.thinking === "string") {
    return prefixed("thinking", block.thinking);
  }
  if (type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "?";
    const id = typeof block.id === "string" ? ` ${block.id}` : "";
    return prefixed(`tool ${name}${id}`, toolJson(block.input));
  }
  if (type === "tool_result") {
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    const mark = block.is_error === true ? "result error" : "result";
    return prefixed(`${mark} ${id}`.trim(), toolResultText(block.content));
  }
  return [type];
}
