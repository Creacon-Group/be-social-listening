import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import {
  BackgroundRunner,
  InProcessBackgroundRunner,
  VercelBackgroundRunner,
} from '../ingestion/application/background-runner.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { GeoAnalyticsService } from './geo-analytics.service.js';
import { GeoController, GeoCronController } from './geo.controller.js';
import { GeoService } from './geo.service.js';
import { SumoPodClient } from './sumopod.client.js';

/** GEO Intelligence: AI visibility benchmark through SumoPod, at most once per month per project. */
@Module({
  imports: [AssistantModule],
  controllers: [GeoController, GeoCronController],
  providers: [
    SumoPodClient,
    GeoService,
    GeoAnalyticsService,
    {
      provide: BackgroundRunner,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('VERCEL', { infer: true })
          ? new VercelBackgroundRunner()
          : new InProcessBackgroundRunner(),
    },
  ],
})
export class GeoModule {}
