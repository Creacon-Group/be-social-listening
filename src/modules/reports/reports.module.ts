import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { InsightsModule } from '../insights/insights.module.js';
import { MentionsModule } from '../mentions/mentions.module.js';
import { MailService } from './mail.service.js';
import { ReportDataService } from './report-data.service.js';
import {
  ReportsController,
  ReportsCronController,
} from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  imports: [AnalyticsModule, InsightsModule, MentionsModule],
  controllers: [ReportsController, ReportsCronController],
  providers: [ReportDataService, ReportsService, MailService],
})
export class ReportsModule {}
