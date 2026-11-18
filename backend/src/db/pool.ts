import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Runs fn inside BEGIN/COMMIT. Rolls back if fn throws. */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
