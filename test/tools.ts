/**
 * Offline registry test for the MCP server — no browser, no login, safe in CI.
 *
 * It builds the real server (src/server.ts) and talks to it over an in-memory
 * transport, so it exercises exactly what a client sees in `tools/list`.
 *
 * Why this exists: `server.tool()` throws when a name is registered twice, and
 * that exception happens at startup, before any tool is callable — the whole
 * server dies. A duplicate `get_product_reviews` (research.ts + reviews.ts) did
 * exactly that, and no test noticed because nothing ever constructed the server.
 *
 * Run with: npm run test:tools
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';
import { accountToolsSetting, setLoggedIn } from '../src/account-mode.js';

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    failures++;
    console.log(`❌ ${name}`);
    console.log(`   ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Tools that modify something and must therefore NOT claim to be read-only. */
const WRITE_TOOLS = [
  'add_to_cart',
  'update_cart_item',
  'like_product',
  'follow_shop',
  'claim_shop_voucher',
  'update_price',
  'update_stock',
  'list_item',
  'unlist_item',
  'upload_product_video',
  'remove_product_video',
  'send_chat_reply',
  'post_shopee_video',
];

/** Tools a signed-out session still exposes (the account ones stay hidden). */
const ACCOUNT_TOOLS = [
  'get_orders',
  'get_order_detail',
  'get_my_vouchers',
  'get_coins',
  'get_notifications',
  'get_cart',
  'add_to_cart',
  'update_cart_item',
  'like_product',
  'follow_shop',
  'get_shop_vouchers',
  'claim_shop_voucher',
];

const names = (tools: Tool[]): string[] => tools.map((t) => t.name);

async function main(): Promise<void> {
  // createServer() throws on a duplicate tool name — the point of this test.
  const server = createServer();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tools-test', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const signedOut = (await client.listTools()).tools;

  check('server builds and registers its tools', () => {
    assert.ok(signedOut.length > 0, 'no tools registered');
    assert.ok(signedOut.length >= 30, `expected >= 30 tools, got ${signedOut.length}`);
  });

  check('tool names are unique', () => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const t of signedOut) {
      if (seen.has(t.name)) dupes.add(t.name);
      seen.add(t.name);
    }
    assert.deepEqual([...dupes], [], `duplicate tool name(s): ${[...dupes].join(', ')}`);
  });

  check('every tool carries annotations (readOnlyHint)', () => {
    const missing = signedOut
      .filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean')
      .map((t) => t.name);
    assert.deepEqual(missing, [], `tool(s) without readOnlyHint: ${missing.join(', ')}`);
  });

  // The account writes only exist in the signed-in list, so build the union:
  // the write-tool check below has to run against both states.
  const allTools = [...signedOut];
  if (accountToolsSetting() === 'auto') {
    setLoggedIn(true);
    allTools.push(...(await client.listTools()).tools);
  }

  check('write tools are not advertised as read-only', () => {
    const wrong = WRITE_TOOLS.filter(
      (n) => allTools.find((t) => t.name === n)?.annotations?.readOnlyHint !== false,
    );
    assert.deepEqual(
      wrong,
      [],
      `write tool(s) claiming readOnlyHint !== false: ${wrong.join(', ')}`,
    );
  });

  check('every tool has a description', () => {
    const missing = signedOut.filter((t) => !t.description?.trim()).map((t) => t.name);
    assert.deepEqual(missing, [], `tool(s) without a description: ${missing.join(', ')}`);
  });

  check('account tools are hidden while signed out', () => {
    const offered = new Set(names(signedOut));
    const visible = ACCOUNT_TOOLS.filter((n) => offered.has(n));
    assert.deepEqual(
      visible,
      [],
      `account tool(s) visible while signed out: ${visible.join(', ')}`,
    );
  });

  if (accountToolsSetting() === 'auto') {
    // Simulate a confirmed login: the account tools appear, nothing else changes.
    setLoggedIn(true);
    const loggedIn = (await client.listTools()).tools;
    check('account tools appear after a login', () => {
      const offered = new Set(names(loggedIn));
      const missing = ACCOUNT_TOOLS.filter((n) => !offered.has(n));
      assert.deepEqual(missing, [], `account tool(s) still hidden: ${missing.join(', ')}`);
      assert.equal(
        loggedIn.length,
        signedOut.length + ACCOUNT_TOOLS.length,
        'unexpected tool count after enabling account mode',
      );
    });
    setLoggedIn(false);
    const signedOutAgain = (await client.listTools()).tools;
    check('account tools hide again after signing out', () => {
      assert.deepEqual(names(signedOutAgain).sort(), names(signedOut).sort());
    });
  } else {
    console.log('⏭  account mode pinned off (SHOPEE_ACCOUNT_TOOLS) — skipping login checks');
  }

  await client.close();
  await server.close();

  console.log(
    `\n${failures === 0 ? '✅ All tool-registry tests passed' : `❌ ${failures} test(s) failed`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Tool-registry test crashed:', err);
  process.exit(1);
});
