import { Module } from '@nestjs/common';
import { FilterResolver } from './mention-filter.js';
import { MENTION_WRITER, PrismaMentionWriter } from './mention.repository.js';
import { MentionsController } from './mentions.controller.js';
import { MentionsService } from './mentions.service.js';

@Module({
  controllers: [MentionsController],
  providers: [
    FilterResolver,
    MentionsService,
    { provide: MENTION_WRITER, useClass: PrismaMentionWriter },
  ],
  exports: [FilterResolver, MentionsService, MENTION_WRITER],
})
export class MentionsModule {}
