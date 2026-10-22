import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Public } from './common/auth.js';
import {
  JwtAuthGuard,
  ProjectAccessGuard,
  RolesGuard,
} from './common/guards.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { type Env, validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AssistantModule } from './modules/assistant/assistant.module.js';
import { AuthController } from './modules/auth/auth.controller.js';
import { IngestionModule } from './modules/ingestion/ingestion.module.js';
import { MentionsModule } from './modules/mentions/mentions.module.js';
import { ProjectsController } from './modules/projects/projects.controller.js';
import { InsightsModule } from './modules/insights/insights.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';

@Controller('health')
class HealthController {
  @Public()
  @Get()
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
      }),
    }),
    DatabaseModule,
    MentionsModule,
    AnalyticsModule,
    IngestionModule,
    AssistantModule,
    InsightsModule,
    ReportsModule,
  ],
  controllers: [HealthController, AuthController, ProjectsController],
  providers: [
    // Order matters: rate limit, authenticate, check role, then check project membership.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
export class AppModule {}
