import { Module } from '@nestjs/common';
import { BrandTaggingService } from './brand-tagging.service.js';
import { ProjectsController } from './projects.controller.js';

@Module({
  controllers: [ProjectsController],
  providers: [BrandTaggingService],
  exports: [BrandTaggingService],
})
export class ProjectsModule {}
