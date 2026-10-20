-- Local development only: `prisma migrate dev` creates a temporary shadow database,
-- so the app user needs rights beyond its own schema.
GRANT ALL PRIVILEGES ON *.* TO 'sl'@'%';
FLUSH PRIVILEGES;
