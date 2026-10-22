import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { ChatRole, Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  createSession(userId: number, projectId: number) {
    return this.prisma.chatSession.create({ data: { userId, projectId } });
  }

  listSessions(userId: number, projectId: number) {
    return this.prisma.chatSession.findMany({
      where: { userId, projectId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async findOwned(sessionId: string, userId: number, projectId: number) {
    const s = await this.prisma.chatSession.findFirst({
      where: { id: sessionId, userId, projectId },
    });
    if (!s) throw new NotFoundException('Chat not found');
    return s;
  }

  async messages(sessionId: string, userId: number, projectId: number) {
    await this.findOwned(sessionId, userId, projectId);
    return this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        role: true,
        content: true,
        filtersSnapshot: true,
        createdAt: true,
      },
    });
  }

  /** Last n messages, oldest first, text only (old tool results are not replayed to the model). */
  async recent(sessionId: string, n: number) {
    const rows = await this.prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { id: 'desc' },
      take: n,
      select: { role: true, content: true },
    });
    return rows.reverse();
  }

  async add(
    sessionId: string,
    m: {
      role: ChatRole;
      content: string;
      filtersSnapshot?: unknown;
      toolCalls?: unknown;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ) {
    const json = (v: unknown) =>
      v === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue);
    await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          sessionId,
          ...m,
          filtersSnapshot: json(m.filtersSnapshot),
          toolCalls: json(m.toolCalls),
        },
      }),
      this.prisma.chatSession.update({
        where: { id: sessionId },
        data: { updatedAt: new Date() },
      }),
    ]);
  }

  setTitle(sessionId: string, title: string) {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { title },
    });
  }

  async deleteOwned(sessionId: string, userId: number, projectId: number) {
    await this.findOwned(sessionId, userId, projectId);
    await this.prisma.chatSession.delete({ where: { id: sessionId } });
  }
}
