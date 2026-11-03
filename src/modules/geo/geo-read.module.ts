import { Module } from '@nestjs/common';
import { GeoAnalyticsService } from './geo-analytics.service.js';

/**
 * Read-only GEO results for other modules (assistant, insights, reports). Kept apart from
 * GeoModule, which depends on the assistant's credits, so there is no import cycle.
 */
@Module({
  providers: [GeoAnalyticsService],
  exports: [GeoAnalyticsService],
})
export class GeoReadModule {}
