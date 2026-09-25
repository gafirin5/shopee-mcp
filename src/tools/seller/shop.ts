import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { portalApi } from '../../seller/api.js';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

// Verified live (2026 portal): the shell fires /api/selleraccount/shop_info/
// on every portal page. Older candidates are kept as capture fallbacks.
const SHOP_INFO_API = '/api/selleraccount/shop_info/';

export function registerSellerShopTools(server: McpServer): void {
  server.tool(
    'get_seller_shop_info',
    'Fetch the logged-in shop profile from the Shopee Seller Centre portal ' +
      '(shop name, id, region, status). Direct portal-API call — works even while ' +
      'a brand-new shop is still on the onboarding gate.',
    {},
    async () => {
      return withErrorHandling(async () => {
        let json: Record<string, unknown>;
        try {
          json = await portalApi<Record<string, unknown>>(SHOP_INFO_API);
        } catch {
          // Fallback: capture whatever the portal shell fires.
          json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.home, [
            '/selleraccount/shop_info',
            '/selleraccount/user_info',
          ]);
        }
        const data = (json.data ?? json) as Record<string, unknown>;
        const name = typeof data.name === 'string' ? data.name : undefined;
        if (name) {
          const flag = (label: string, v: unknown): string => `   ${v ? '✅' : '—'} ${label}`;
          const lines = [
            '🏪 Seller Shop Info',
            '',
            `   Nama toko   : ${name}`,
            `   Shop ID     : ${String(data.shop_id ?? '?')}`,
            `   Region      : ${String(data.shop_region ?? '?')}`,
            flag('Official Shop (Mall)', data.official_shop),
            flag('Toko Mart', data.is_mart_shop),
            flag('SIP aktif', data.is_sip_primary || data.is_sip_affiliated),
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        return {
          content: [{ type: 'text', text: formatSellerPayload('🏪 Seller Shop Info', json, []) }],
        };
      });
    },
  );

  server.tool(
    'get_seller_income',
    'Fetch the wallet/income summary page from the Seller Centre portal ' +
      '(/portal/finance/income — balance snapshot the income page loads).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.income, [
          '/finance/income',
          '/income/',
          '/wallet',
          '/balance',
        ]);
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload('💰 Seller Income', json, [
                'balance_list',
                'wallet_list',
                'list',
              ]),
            },
          ],
        };
      });
    },
  );

  server.tool(
    'get_seller_analytics',
    'Fetch the shop performance dashboard from the Seller Centre (business insight ' +
      'lives in the separate /datacenter/ app — this captures what it loads).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.analytics, [
          '/datacenter',
          '/data/',
          '/analytics',
          '/performance',
        ]);
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload('📈 Shop Analytics', json, ['metrics', 'list', 'kpi_list']),
            },
          ],
        };
      });
    },
  );

  server.tool(
    'get_seller_marketing',
    'Fetch the marketing/promotions overview from the Seller Centre portal ' +
      '(/portal/marketing — active campaigns snapshot).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.marketing, [
          '/marketing',
          '/promotion',
          '/campaign',
          '/activity',
        ]);
        return {
          content: [
            {
              type: 'text',
              text: formatSellerPayload('📣 Marketing Overview', json, [
                'list',
                'campaign_list',
                'activity_list',
              ]),
            },
          ],
        };
      });
    },
  );
}
