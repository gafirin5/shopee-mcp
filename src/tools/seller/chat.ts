import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sellerCaptureRaw } from '../../seller/capture.js';
import { withSellerAction, assertSellerWritesEnabled } from '../../actions/base.js';
import { openChat, openConversation, sendReply, CHAT_SEL } from '../../seller/pages/chat.js';
import { withErrorHandling } from '../../utils/errors.js';
import { confirmGate } from '../../utils/confirm.js';
import { summarizeJson } from '../../utils/json.js';

const CONV_CANDIDATES = ['/conversation', '/chat/list', '/chat/get', '/message/list'];

export function registerSellerChatTools(server: McpServer): void {
  server.tool(
    'list_chats',
    'List buyer conversations from the Shopee seller chat web app (read-only capture ' +
      'of the list the app itself loads). The raw response shows buyer names and chat ids ' +
      'for read_chat / send_chat_reply.',
    {},
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async () => {
      return withErrorHandling(async () => {
        const { json, matchedUrl } = await sellerCaptureRaw<unknown>(
          '/chat/pc',
          CONV_CANDIDATES,
          45000,
        );
        return {
          content: [
            {
              type: 'text',
              text: `💬 Conversations (via ${matchedUrl})\n\n${summarizeJson(json, 4000)}`,
            },
          ],
        };
      });
    },
  );

  server.tool(
    'read_chat',
    'Open a conversation in the seller chat app and read the visible message thread. ' +
      'Match by buyer name or chat id as shown by list_chats. Returns the last `limit` ' +
      'messages in order.',
    {
      match: z
        .string()
        .optional()
        .describe('Buyer name / chat id text to match in the conversation list (default: newest)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .describe('How many of the latest messages to return (default 30)'),
    },
    { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    async ({ match, limit }) => {
      return withErrorHandling(async () => {
        const text = await withSellerAction('read-chat', async (page) => {
          await openChat(page);
          await openConversation(page, match);
          const bubbles = page.locator(CHAT_SEL.messageBubble);
          const n = Math.min(await bubbles.count(), limit);
          const lines: string[] = [];
          for (let i = 0; i < n; i++) {
            const msg = (
              await bubbles
                .nth(i)
                .innerText()
                .catch(() => '')
            ).trim();
            if (msg) lines.push(msg.replace(/\n+/g, ' | '));
          }
          return lines.length
            ? `💬 Thread${match ? ` for "${match}"` : ''} — last ${lines.length} message(s):\n\n` +
                lines.join('\n')
            : 'No message bubbles rendered. The thread may be empty, or the bubble selector ' +
                'drifted — check the debug screenshot and update CHAT_SEL.messageBubble.';
        });
        return { content: [{ type: 'text', text }] };
      });
    },
  );

  server.tool(
    'send_chat_reply',
    'Send a chat reply to a buyer through the seller chat composer (typed keystrokes, ' +
      'one message per call, on your own shop). Requires confirm=true (preview otherwise).',
    {
      match: z
        .string()
        .optional()
        .describe('Buyer name / chat id to open (default: newest conversation)'),
      message: z.string().min(1).max(2000).describe('The reply text to send'),
      confirm: z.boolean().default(false).describe('Must be true to actually send'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ match, message, confirm }) => {
      return withErrorHandling(async () => {
        assertSellerWritesEnabled('send_chat_reply');
        const gate = confirmGate(
          confirm,
          `Send chat reply${match ? ` to "${match}"` : ' to the newest conversation'}:\n\n> ${message}`,
        );
        if (gate) return gate;
        const text = await withSellerAction(
          'send-chat-reply',
          async (page) => {
            await openChat(page);
            await openConversation(page, match);
            const bubbles = page.locator(CHAT_SEL.messageBubble);
            const before = await bubbles.count();
            await sendReply(page, message);
            const after = await bubbles.count();
            return after > before
              ? `✅ Reply sent${match ? ` to "${match}"` : ''}:\n${message}`
              : `⚠️ Message typed and Enter pressed, but no new bubble was detected — verify in ` +
                  `the chat window. If the composer selector drifted, update CHAT_SEL.`;
          },
          `reply ${match ?? '(newest)'}: ${message.slice(0, 80)}`,
        );
        return { content: [{ type: 'text', text }] };
      });
    },
  );
}
