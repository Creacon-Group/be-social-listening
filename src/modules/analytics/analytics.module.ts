import { Module } from '@nestjs/common';
import { MentionsModule } from '../mentions/mentions.module.js';
import { AccountsController } from './accounts.controller.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { AnalyticsService } from './analytics.service.js';

@Module({
  imports: [MentionsModule],
  controllers: [AnalyticsController, AccountsController],
  providers: [AnalyticsRepository, AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
