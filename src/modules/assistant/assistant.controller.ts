import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import { type AuthUser, CurrentUser } from '../../common/auth.js';
import { MentionFilterDto } from '../mentions/mention-filter.js';
import { AssistantService } from './assistant.service.js';
import { ChatRepository } from './chat.repository.js';
import { RateLimit } from '../../common/rate-limit.js';

class ChatRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MentionFilterDto)
  filter: MentionFilterDto = { range: '7d' };
}

@ApiTags('assistant')
@Controller('projects/:projectId/assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly chats: ChatRepository,
  ) {}

  @Post('sessions')
  createSession(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.createSession(user.id, projectId);
  }

  @Get('sessions')
  listSessions(
    @Param('projectId', ParseIntPipe) projectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.listSessions(user.id, projectId);
  }

  @Get('sessions/:sessionId/messages')
  messages(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.chats.messages(sessionId, user.id, projectId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.chats.deleteOwned(sessionId, user.id, projectId);
  }

  /** Streams the answer as an AI SDK UI message stream (SSE), compatible with useChat on the FE. */
  @Post('sessions/:sessionId/chat')
  @RateLimit(20)
  async chat(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() dto: ChatRequestDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(); // user closed the tab or pressed Stop
    });
    await this.assistant.chat({
      userId: user.id,
      projectId,
      sessionId,
      text: dto.text,
      filter: dto.filter,
      res,
      signal: ac.signal,
    });
  }
}
