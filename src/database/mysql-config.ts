import type { PoolConfig } from 'mariadb';

/**
 * DATABASE_URL -> mariadb driver options (Prisma 7 talks to MySQL through @prisma/adapter-mariadb).
 * Query params: connection_limit, sslaccept=strict or ssl=true (managed MySQL such as TiDB Cloud;
 * sslaccept is what Prisma Migrate understands, so prefer it),
 * allowPublicKeyRetrieval=true (local MySQL 8 without TLS).
 */
export function mysqlConfigFromUrl(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  const flag = (name: string) => url.searchParams.get(name) === 'true';
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectionLimit: Number(url.searchParams.get('connection_limit') ?? 5),
    ssl:
      flag('ssl') || url.searchParams.has('sslaccept')
        ? {
            rejectUnauthorized:
              url.searchParams.get('sslaccept') !== 'accept_invalid_certs',
          }
        : undefined,
    allowPublicKeyRetrieval: flag('allowPublicKeyRetrieval'),
    connectTimeout: 10_000, // remote TLS handshakes (TiDB Cloud) can exceed the 1 s default
    timezone: 'Z',
  };
}
