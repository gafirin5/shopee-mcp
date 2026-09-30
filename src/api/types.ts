// ─── Search Types ─────────────────────────────────────────────────────────────
// Shape of Shopee's /api/v4/search/search_items response (subset we use).

export interface ItemRating {
  rating_star: number;
  rating_count: number[];
}

export interface ItemBasic {
  itemid: number;
  shopid: number;
  name: string;
  /** Price in the currency's smallest unit × 100000 (divide by 100000 for IDR). */
  price: number;
  price_min: number;
  price_max: number;
  price_before_discount: number;
  currency: string;
  stock: number;
  sold: number;
  historical_sold: number;
  liked_count: number;
  discount?: string;
  item_rating: ItemRating;
  shop_location: string;
  is_official_shop: boolean;
  shopee_verified: boolean;
  image: string;
}

// ─── Newer search card shape ────────────────────────────────────────────────
//
// Shopee has been migrating search results to a card-component format that
// leaves `item_basic` null and splits the product across `item_data` (numbers,
// rating, shop) and `item_card_displayed_asset` (name, image, location).
// Observed live on shopee.com.my; both shapes are handled (see
// flattenSearchItems), since which one a domain serves can change at any time.

export interface CardDisplayPrice {
  /** Real amount × 100000, same scale as the legacy fields. */
  price: number;
  strikethrough_price?: number | null;
  original_price?: number | null;
  discount?: number | null;
}

export interface CardSoldCount {
  historical_sold_count?: number | null;
  monthly_sold_count?: number | null;
  /** Pre-formatted by Shopee, e.g. "20k+ sold". */
  historical_sold_count_text?: string | null;
  monthly_sold_count_text?: string | null;
}

export interface CardItemData {
  itemid?: number;
  shopid?: number;
  item_card_display_price?: CardDisplayPrice | null;
  item_card_display_sold_count?: CardSoldCount | null;
  item_rating?: ItemRating | null;
  shop_data?: { shop_name?: string | null } | null;
  shopee_verified?: boolean | null;
}

export interface CardDisplayedAsset {
  name?: string | null;
  image?: string | null;
  shop_location?: string | null;
}

export interface SearchItem {
  itemid: number;
  shopid: number;
  /** Null on newer card-shaped results; the product then lives in the fields below. */
  item_basic: ItemBasic;
  item_data?: CardItemData | null;
  item_card_displayed_asset?: CardDisplayedAsset | null;
  /**
   * Legacy shape: recommendation/ads cards with no top-level `item_basic` nest
   * their real product cards here.
   *
   * Newer cards reuse the key differently: `{item_id, shop_id, model_id, info}`
   * describing the SAME product, not extra ones. On a "virtual item" card the
   * top-level `itemid`/`shopid` are a synthetic selection-model placeholder that
   * `pdp/get_pc` rejects with error 266900504 — the real purchasable listing is
   * here. (`info` is ad tracking; the ids are genuine.)
   */
  real_items?: Array<{
    item_basic?: ItemBasic;
    item_id?: number;
    shop_id?: number;
    model_id?: number;
  }>;
}

export interface SearchItemsResponse {
  error?: number;
  error_msg?: string;
  total_count: number;
  nomore: boolean;
  items: SearchItem[] | null;
}

/**
 * One product, normalised from whichever card shape Shopee returned, so the
 * formatting code doesn't have to care which one it was.
 */
export interface SearchResult {
  itemid: number;
  shopid: number;
  name: string;
  /** All prices are the real amount × 100000. */
  price: number;
  priceMin?: number;
  priceMax?: number;
  priceBeforeDiscount?: number;
  /** Absent on newer cards — callers fall back to the region's currency. */
  currency?: string;
  ratingStar?: number;
  sold?: number;
  /** Pre-formatted sold text when Shopee supplies one instead of a raw count. */
  soldText?: string;
  shopLocation?: string;
  /** Only the legacy shape reports Shopee Mall membership. */
  isOfficialShop?: boolean;
}

// ─── Product Detail Types ───────────────────────────────────────────────────
// Subset of /api/v4/pdp/get_pc → data.

export interface PdpCategory {
  display_name: string;
}

/** One purchasable variant of a listing. */
export interface PdpModel {
  model_id: number;
  name: string;
  /** Real amount × 100000, as everywhere else. */
  price: number;
  price_before_discount?: number | null;
  /**
   * Exact counts are null in the PC PDP payload (detail_level 0) — Shopee only
   * returns them from cart_panel/select_variation_pc, one variant at a time.
   */
  stock?: number | null;
  normal_stock?: number | null;
  /** Whether the variant can be bought at all; the only stock signal get_pc gives. */
  has_stock?: boolean | null;
  status?: number | null;
  extinfo?: {
    tier_index?: number[];
    is_pre_order?: boolean;
    estimated_days?: number;
  } | null;
}

/** One axis of variation, e.g. "Colour" with options ["Red", "Blue"]. */
export interface PdpTierVariation {
  name: string;
  options: string[];
}

/** Response to selecting a variant — the only place exact stock appears. */
export interface SelectVariationResponse {
  error?: number;
  error_msg?: string;
  data?: { stock?: number | null };
}

export interface PdpItem {
  item_id: number;
  shop_id: number;
  title: string;
  models?: PdpModel[] | null;
  tier_variations?: PdpTierVariation[] | null;
  brand?: string;
  /** 1 = new, otherwise used. */
  condition?: number;
  currency?: string;
  item_rating?: { rating_star: number; rating_count: number[] };
  shop_location?: string;
  categories?: PdpCategory[];
  description?: string;
  image?: string;
  stock?: number | null;
  normal_stock?: number | null;
  historical_sold?: number;
  global_sold_count?: number;
  is_free_shipping?: boolean;
  is_official_shop?: boolean;
}

/** A price value: prices are the real amount × 100000. range_* are -1 when single. */
export interface PdpPriceValue {
  single_value: number;
  range_min: number;
  range_max: number;
}

export interface PdpProductPrice {
  discount?: number;
  price: PdpPriceValue;
  price_before_discount?: PdpPriceValue;
}

/** /api/v4/pdp/get_pc → data.product_review — where the sold/review counts live. */
export interface PdpProductReview {
  total_rating_count?: number;
  cmt_count?: number;
  /** Human-formatted sold counts, e.g. "355", "1,2rb". */
  sold_count_display?: string;
  historical_sold_display?: string;
  global_sold_display?: string;
}

export interface PdpResponse {
  error?: number;
  error_msg?: string;
  data?: {
    item: PdpItem;
    product_price: PdpProductPrice;
    product_review?: PdpProductReview;
    product_attributes?: { attrs?: PdpAttribute[] | null } | null;
    product_shipping?: PdpShipping | null;
    shop_detailed?: PdpShop | null;
  };
}

/** get_pc → data.product_attributes: the listing's spec sheet. */
export interface PdpAttribute {
  name: string;
  value: string;
  /** Null on Shopee's synthetic rows (e.g. "Discount stock"), set on real specs. */
  id?: number | null;
}

export interface PdpChannel {
  name: string;
  price?: PdpPriceValue;
  channel_delivery_info?: { edt_text?: string | null } | null;
}

/** get_pc → data.product_shipping. */
export interface PdpShipping {
  free_shipping?: { min_spend?: PdpPriceValue | null; has_fss?: boolean } | null;
  shipping_fee_info?: { ship_from_location?: string; price?: PdpPriceValue } | null;
  ungrouped_channel_infos?: PdpChannel[] | null;
}

/** get_pc → data.shop_detailed: the seller, bundled with the listing. */
export interface PdpShop {
  shopid: number;
  name: string;
  place?: string;
  rating_star?: number;
  response_rate?: number;
  follower_count?: number;
  item_count?: number;
  is_official_shop?: boolean;
  is_shopee_verified?: boolean;
  is_preferred_plus_seller?: boolean;
  vacation?: boolean;
}

// ─── Review Types ───────────────────────────────────────────────────────────
// Subset of /api/v2/item/get_ratings (reviews are still served from v2).

export interface Rating {
  cmtid: number;
  rating_star: number;
  comment?: string | null;
  author_username?: string | null;
  anonymous?: boolean;
  /** Unix seconds. */
  ctime: number;
  like_count?: number | null;
  images?: string[] | null;
  videos?: unknown[] | null;
  product_items?: Array<{ model_name?: string | null }> | null;
  ItemRatingReply?: { comment?: string | null } | null;
}

export interface RatingSummary {
  rating_total: number;
  /** Counts for 1★..5★, in that order. */
  rating_count: number[];
  rcount_with_context?: number;
  rcount_with_media?: number;
}

export interface RatingsResponse {
  error?: number;
  error_msg?: string;
  data?: {
    ratings?: Rating[] | null;
    item_rating_summary?: RatingSummary | null;
    has_more?: boolean;
  };
}

// ─── Shop Types ─────────────────────────────────────────────────────────────
// Subset of /api/v4/shop/get_shop_base_v2 → data.

export interface ShopBase {
  shopid: number;
  userid?: number;
  name: string;
  description?: string | null;
  account?: { username?: string } | null;
  rating_star?: number;
  follower_count?: number;
  item_count?: number;
  response_rate?: number;
  /** Seconds. */
  response_time?: number;
  /** Unix seconds. */
  ctime?: number;
  last_active_time?: number;
  vacation?: boolean;
  is_official_shop?: boolean;
  is_shopee_verified?: boolean;
  is_preferred_plus_seller?: boolean;
}

export interface ShopBaseResponse {
  error?: number;
  error_msg?: string;
  data?: ShopBase;
}

// ─── Flash Sale Types ───────────────────────────────────────────────────────

export interface FlashSaleSession {
  promotionid: number;
  name?: string;
  /** Unix seconds. */
  start_time: number;
  end_time: number;
  is_ongoing?: boolean;
}

export interface FlashSaleItem {
  itemid: number;
  shopid: number;
  name: string;
  price: number;
  price_before_discount?: number;
  discount?: string | null;
  /** Units still available at the flash price. */
  stock?: number;
  /** Units allocated to the flash sale in total. */
  flash_sale_stock?: number;
  promotionid?: number;
  item_rating?: { rating_star?: number } | null;
}
