import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { UserRole } from '../../generated/prisma/client.js';
import { toWibYmd } from '../mentions/mention-filter.js';

const WIB_OFFSET_MS = 7 * 3_600_000;

/** Today's WIB calendar day as a DATE value (midnight UTC of that date). */
export const wibToday = (now = new Date()) =>
  new Date(`${toWibYmd(now)}T00:00:00.000Z`);

/** Next 00:00 WIB, when daily credits reset. */
export const nextWibMidnight = (now = new Date()) =>
  new Date(wibToday(now).getTime() + 86_400_000 - WIB_OFFSET_MS);

export interface CreditStatus {
  unlimited: boolean;
  limit: number; // daily limit + today's bonus
  used: number;
  remaining: number | null; // null when unlimited
  resetsAt: string;
  contact: string | null; // account manager contact shown when credits run out
}

/**
 * Daily AI Assistant credits: one credit per answered question, reset at 00:00 WIB.
 * Only answers that finish are charged; a failed or stopped answer costs nothing.
 */
@Injectable()
export class ChatCreditsService {
  private readonly contact: string | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.contact =
      config.get('ACCOUNT_MANAGER_CONTACT', { infer: true }) ?? null;
  }

  async status(userId: number, role: UserRole): Promise<CreditStatus> {
    const day = wibToday();
    const [user, usage] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { dailyChatCredits: true },
      }),
      this.prisma.chatUsage.findUnique({
        where: { userId_day: { userId, day } },
      }),
    ]);
    const limit = user.dailyChatCredits + (usage?.bonus ?? 0);
    const used = usage?.used ?? 0;
    const unlimited = role === 'SUPERADMIN';
    return {
      unlimited,
      limit,
      used,
      remaining: unlimited ? null : Math.max(0, limit - used),
      resetsAt: nextWibMidnight().toISOString(),
      contact: this.contact,
    };
  }

  /** Throws 429 CREDITS_EXHAUSTED before anything is sent to the model. */
  async assertAvailable(userId: number, role: UserRole) {
    const s = await this.status(userId, role);
    if (s.unlimited || (s.remaining ?? 0) > 0) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'CREDITS_EXHAUSTED',
        message:
          "You have used today's assistant credits. Contact your account manager to add credits.",
        resetsAt: s.resetsAt,
        contact: s.contact,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** Charge one credit for an answered question. */
  async consume(userId: number) {
    const day = wibToday();
    await this.prisma.chatUsage.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, used: 1 },
      update: { used: { increment: 1 } },
    });
  }

  /** Superadmin: list users with today's usage. */
  async listUsers() {
    const day = wibToday();
    const users = await this.prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        dailyChatCredits: true,
        chatUsage: { where: { day }, select: { used: true, bonus: true } },
      },
    });
    return users.map(({ chatUsage, ...u }) => ({
      ...u,
      usedToday: chatUsage[0]?.used ?? 0,
      bonusToday: chatUsage[0]?.bonus ?? 0,
    }));
  }

  /** Superadmin: permanent daily limit. */
  async setDailyLimit(userId: number, dailyChatCredits: number) {
    await this.assertUser(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { dailyChatCredits },
    });
  }

  /** Superadmin: extra credits for today only. */
  async addBonusToday(userId: number, amount: number) {
    const day = wibToday();
    await this.assertUser(userId);
    await this.prisma.chatUsage.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, bonus: amount },
      update: { bonus: { increment: amount } },
    });
  }

  /** Superadmin: create a user and add them to every project. */
  async createUser(dto: {
    email: string;
    name: string;
    role: 'ADMIN' | 'ANALYST' | 'VIEWER';
    password: string;
    dailyChatCredits: number;
  }) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.count({ where: { email } }))
      throw new ConflictException('This email already has an account');
    const projects = await this.prisma.project.findMany({
      select: { id: true },
    });
    const user = await this.prisma.user.create({
      data: {
        email,
        name: dto.name.trim(),
        role: dto.role,
        dailyChatCredits: dto.dailyChatCredits,
        passwordHash: await bcrypt.hash(dto.password, 12),
        memberships: { create: projects.map((p) => ({ projectId: p.id })) },
      },
      select: { id: true, email: true, name: true, role: true },
    });
    return user;
  }

  private async assertUser(userId: number) {
    const n = await this.prisma.user.count({ where: { id: userId } });
    if (!n) throw new NotFoundException('User not found');
  }
}
