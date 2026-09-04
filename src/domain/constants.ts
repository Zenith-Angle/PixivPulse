export const APP_NAME = "PixivPulse";
export const PARSER_VERSION = 1;
export const PAGE_FAILURE_CLASSIFIER_VERSION = 2;
export const DB_VERSION = 8;
/** The encoded cover format is intentionally independent from the app build. */
export const COVER_CACHE_PIPELINE_VERSION = 1;
export const COVER_CACHE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const COVER_CACHE_MAX_BLOB_BYTES = 150 * 1024;
export const COVER_CACHE_MAX_READY_BYTES = 128 * 1024 * 1024;
export const COVER_CACHE_BATCH_SIZE = 8;
export const COVER_CACHE_INTER_IMAGE_DELAY_MS = 350;
export const COVER_CACHE_FETCH_TIMEOUT_MS = 8_000;
export const COVER_CACHE_ALARM = "pixiv-pulse-cover-cache";
export const RETENTION_MAINTENANCE_ALARM = "pixiv-pulse-retention-maintenance";
export const SYNC_ALARM = "pixiv-pulse-sync";
export const SYNC_WATCHDOG_ALARM = "pixiv-pulse-sync-watchdog";
export const SYNC_ROUTE_MARKER = "pixivPulseRun";
export const DEFAULT_SYNC_INTERVAL_HOURS = 1;
export const SUPPORTED_SYNC_INTERVAL_HOURS = [0.5, 1, 2, 4, 12, 24] as const;
export const MAX_SYNC_PAGES = 200;
export const MAX_SYNC_RETRIES = 1;
export const PAGE_STABLE_MS = 800;
export const PAGE_READY_TIMEOUT_MS = 30_000;
export const LOCK_LEASE_MS = 120_000;
export const FINE_GRAINED_RETENTION_DAYS = 90;
/** Retention is lossless up to this age. This is a policy invariant rather
 * than a user setting: callers cannot opt out of the recent-history window. */
export const LOSSLESS_RETENTION_HOURS = 72;
export const RETENTION_30M_MAX_DAYS = 7;
export const RETENTION_1H_MAX_DAYS = 30;
export const RETENTION_SCHEMA_VERSION = 2;
export const MAX_STORAGE_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export const PIXIV_WORKS_URL = "https://www.pixiv.net/dashboard/works";
export const ALLOWED_IMAGE_HOST = "i.pximg.net";
export const ALLOWED_LINK_HOST = "www.pixiv.net";
