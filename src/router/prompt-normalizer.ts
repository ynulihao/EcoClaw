const LEADING_UNTRUSTED_METADATA_BLOCKS =
  /^(?:[^\n]*\(untrusted metadata\):\n```json\n[\s\S]*?\n```\n*)+/i;
const LEADING_TIMESTAMP_SHELL =
  /^\[(?=[^\]\n]*\d{4}-\d{2}-\d{2})(?=[^\]\n]*(?:GMT|UTC))[^\]\n]*\]\s*/i;
const TRAILING_MESSAGE_ID_SHELL = /\n*\[message_id:\s*[^\]\n]+\]\s*$/i;

export function normalizePromptForClassification(prompt: string): string {
  let normalized = prompt.trim();

  // OpenClaw can wrap user text with one or more untrusted metadata blocks and
  // a bracketed transport timestamp. Strip those before embedding/classification.
  for (;;) {
    const next = normalized
      .replace(LEADING_UNTRUSTED_METADATA_BLOCKS, "")
      .replace(LEADING_TIMESTAMP_SHELL, "")
      .replace(TRAILING_MESSAGE_ID_SHELL, "")
      .trim();

    if (next === normalized) break;
    normalized = next;
  }

  return normalized || prompt.trim();
}
