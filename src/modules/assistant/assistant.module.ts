import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { MentionsModule } from '../mentions/mentions.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { ChatCreditsService } from './chat-credits.service.js';
import { ChatRepository } from './chat.repository.js';
import { CreditsController } from './credits.controller.js';
import { ModelProvider } from './model.provider.js';

@Module({
  imports: [AnalyticsModule, MentionsModule],
  controllers: [AssistantController, CreditsController],
  providers: [
    AssistantService,
    ChatRepository,
    ChatCreditsService,
    ModelProvider,
  ],
})
export class AssistantModule {}
