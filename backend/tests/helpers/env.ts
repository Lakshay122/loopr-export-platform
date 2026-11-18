/** Defaults match docker-compose.yml host ports. Inside the `test` container they are overridden. */
export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loopr:loopr@localhost:55432/loopr_test';
export const TEST_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:56379';
