import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdir, writeFile } from 'node:fs/promises';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Zanroo webhook batches are large (about 25 KB per message); Vercel caps a request at 4.5 MB.
  app.useBodyParser('json', { limit: '4.5mb' });
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  // req.ip follows X-Forwarded-For only when it comes from a local reverse proxy (Nginx, Docker
  // network), so clients cannot fake their IP to dodge the rate limit.
  app.set('trust proxy', 'loopback, uniquelocal');

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors({
    origin: config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });

  const openapi = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Social Listening API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );

  // `npm run openapi` writes the contract the FE generates its types from.
  if (process.argv.includes('--export-openapi')) {
    await mkdir('docs/api-spec', { recursive: true });
    await writeFile(
      'docs/api-spec/openapi.json',
      JSON.stringify(openapi, null, 2),
    );
    await app.close();
    return;
  }

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    SwaggerModule.setup('api/docs', app, openapi);
  }

  await app.listen(config.get('PORT', { infer: true }));
}
// No top-level await: Vercel loads this file with require(), which rejects ESM graphs that use it.
void bootstrap();
