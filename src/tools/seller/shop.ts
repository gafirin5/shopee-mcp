import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sellerCapture } from '../../seller/capture.js';
import { SELLER_PATHS } from '../../seller/urls.js';
import { withErrorHandling } from '../../utils/errors.js';
import { formatSellerPayload } from './format.js';

// The portal fires one of these depending on UI generation; whichever the live
// app actually calls is the one we capture. When none match, the tool's error
// text routes you to seller_api_probe.
const SHOP_INFO_CANDIDATES = [
  '/shop/info',
  '/get_shop_info',
  '/shop/get_shop_info',
  '/user/get_user_info',
  '/account/info',
];

export function registerSellerShopTools(server: McpServer): void {
  server.tool(
    'get_seller_shop_info',
    'Fetch the logged-in shop profile from the Shopee Seller Centre portal ' +
      '(shop name, account, status). Requires the seller session (npm run login:seller).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(
          SELLER_PATHS.home,
          SHOP_INFO_CANDIDATES,
        );
        return {
          content: [{ type: 'text', text: formatSellerPayload('🏪 Seller Shop Info', json, []) }],
        };
      });
    },
  );

  server.tool(
    'get_seller_income',
    'Fetch the wallet/income summary page from the Seller Centre portal ' +
      '(balance snapshot shown on the income page).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.income, [
          '/income',
          '/wallet',
          '/balance',
          '/payment',
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
    'Fetch the shop performance dashboard from the Seller Centre portal ' +
      '(visits, orders, sales snapshot for the default period).',
    {},
    async () => {
      return withErrorHandling(async () => {
        const json = await sellerCapture<Record<string, unknown>>(SELLER_PATHS.analytics, [
          '/data/',
          '/analytics',
          '/performance',
          '/dashboard',
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
      '(active campaigns snapshot).',
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
