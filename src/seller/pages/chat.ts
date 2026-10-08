import type { Page } from 'playwright';
import { ACTION_TIMEOUT_MS } from '../../actions/base.js';
import { SELLER_BASE_URL } from '../../browser/session.js';

/**
 * Selectors for the Shopee seller chat web app. The chat UI is one of the
 * most-drifted surfaces in the portal; all selectors live here. Read tools
 * capture the app's own XHRs (list/messages), and replies are typed through
 * the real composer so Shopee-side validations still apply.
 */
export const CHAT_SEL = {
  /** Conversation entries in the left list. */
  conversationItem:
    '[class*="conversation" i] [class*="item" i], [class*="chat-list" i] [class*="item" i], li[class*="conv" i]',
  /** Composer input (contenteditable div or textarea). */
  composer:
    '[contenteditable="true"], textarea[placeholder*="pesan" i], textarea[placeholder*="message" i], div[class*="input" i] textarea',
  /** Send button fallback (Enter usually works). */
  sendButton:
    'button[class*="send" i], [class*="send" i] button, button[aria-label*="kirim" i], button[aria-label*="send" i]',
  /** Message bubbles in the open thread. */
  messageBubble: '[class*="message" i][class*="item" i], [class*="msg" i][class*="text" i]',
} as const;

// Verified from the 2026 sidebar: /portal/chat-management is the chat entry;
// the webchat API surface (webchat/api/…) lives under the same subdomain.
export const CHAT_PATHS = ['/portal/chat-management', '/chat/pc', '/chat', '/portal/chat'];

/** Open the chat app, trying each known mount path until one renders. */
export async function openChat(page: Page): Promise<string> {
  let lastUrl = '';
  for (const p of CHAT_PATHS) {
    await page.goto(`${SELLER_BASE_URL}${p}`, {
      waitUntil: 'domcontentloaded',
      timeout: ACTION_TIMEOUT_MS,
    });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    lastUrl = page.url();
    const conv = page.locator(CHAT_SEL.conversationItem);
    if ((await conv.count()) > 0) return lastUrl;
  }
  throw new Error(
    `Could not find the chat conversation list (tried ${CHAT_PATHS.join(', ')}; landed on ${lastUrl}). ` +
      'Check the debug screenshot — if Shopee moved the chat app, update CHAT_PATHS.',
  );
}

/**
 * Click the conversation whose text contains `match` (buyer name or chat id).
 * With no match, opens the first (newest) conversation.
 */
export async function openConversation(page: Page, match?: string): Promise<string> {
  const items = page.locator(CHAT_SEL.conversationItem);
  const n = await items.count();
  if (!n) throw new Error('No conversations rendered on the chat page (see screenshot).');
  if (!match) {
    await items.first().click();
  } else {
    const wanted = match.trim().toLowerCase();
    const contains: number[] = [];
    const exact: number[] = [];
    for (let i = 0; i < n; i++) {
      const text = (
        (await items
          .nth(i)
          .innerText()
          .catch(() => '')) || ''
      ).toLowerCase();
      if (!text.includes(wanted)) continue;
      contains.push(i);
      // A buyer's name sits on a line of its own. A bare substring can be part of another
      // name or of a message preview, so it is used only when no line matches exactly.
      if (text.split('\n').some((line) => line.trim() === wanted)) exact.push(i);
    }
    if (contains.length === 0) {
      throw new Error(
        `No conversation matching "${match}" among ${n} entries — pass a buyer name or chat id shown in the list.`,
      );
    }
    const candidates = exact.length ? exact : contains;
    if (candidates.length > 1) {
      // Two buyers can share a name. Picking one would send the reply to the wrong person.
      throw new Error(
        `${candidates.length} conversations match "${match}" — pass the exact buyer name or chat id from list_chats.`,
      );
    }
    await items.nth(candidates[0]).click();
  }
  // Give the thread XHR a beat to land.
  await page.waitForTimeout(1500);
  return (await page.url()) || 'chat';
}

/** Type a reply into the composer and send it (Enter, falling back to the button). */
export async function sendReply(page: Page, message: string): Promise<void> {
  const composer = page.locator(CHAT_SEL.composer).first();
  await composer.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await composer.click();
  if (
    (await composer.getAttribute('contenteditable')) === 'true' ||
    (await composer.evaluate((el) => (el as HTMLElement).isContentEditable).catch(() => false))
  ) {
    await page.keyboard.type(message, { delay: 30 });
  } else {
    await composer.fill(message);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  // If Enter didn't send, try the button.
  const send = page.locator(CHAT_SEL.sendButton).first();
  if (await send.isVisible().catch(() => false)) {
    await send.click().catch(() => {});
  }
  await page.waitForTimeout(800);
}
