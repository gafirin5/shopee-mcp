/**
 * Two-step confirmation gate for write tools: without `confirm: true` the tool
 * returns a PREVIEW of what it would do and executes nothing. This keeps an
 * AI client from performing account-touching actions uninvited.
 */
export function confirmGate(
  confirm: boolean | undefined,
  preview: string,
): { content: Array<{ type: 'text'; text: string }> } | null {
  if (confirm) return null;
  return {
    content: [
      {
        type: 'text',
        text:
          '⚠️ **WRITE PREVIEW — nothing executed yet**\n\n' +
          `${preview}\n\n` +
          'Call this tool again with `confirm: true` to execute. ' +
          'Write actions are rate-limited (1–3 min spacing, hourly/daily budgets) ' +
          'and logged to ~/.shopee-mcp/audit.log.',
      },
    ],
  };
}
