import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AccountType, Channel } from '../../generated/prisma/enums.js';
import { Prisma } from '../../generated/prisma/client.js';
import { FilterResolver } from '../mentions/mention-filter.js';
import { ownedPaidSet } from '../mentions/mention-sql.js';

class AccountRef {
  @IsEnum(Channel) channel!: Channel;
  @IsString() @MaxLength(150) handle!: string;
}

/** Bulk classification. A field left out is not changed; null clears it (back to the Zanroo-derived value). */
class TagAccountsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AccountRef)
  accounts!: AccountRef[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsEnum(AccountType)
  accountType?: AccountType | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsBoolean()
  isPaid?: boolean | null;
}

class ProjectSettingsDto {
  @IsOptional() @IsBoolean() nssIncludeNeutral?: boolean;
  @IsOptional() @IsBoolean() showNss?: boolean;
}

const cleanHandle = (h: string) => h.trim().replace(/^@/, '');

@ApiTags('accounts')
@Controller('projects/:projectId')
export class AccountsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filters: FilterResolver,
  ) {}

  /** Accounts an analyst has classified by hand. */
  @Get('accounts')
  list(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.prisma.accountProfile.findMany({
      where: { projectId },
      select: {
        channel: true,
        handle: true,
        accountType: true,
        isPaid: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Mark one or many accounts as KOL / Media / Official / Other and/or paid vs organic. */
  @Put('accounts')
  @Roles('ADMIN', 'ANALYST')
  async tag(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: TagAccountsDto,
    @CurrentUser() user: AuthUser,
  ) {
    const data = {
      ...(dto.accountType !== undefined && { accountType: dto.accountType }),
      ...(dto.isPaid !== undefined && { isPaid: dto.isPaid }),
      updatedById: user.id,
    };
    const unique = [
      ...new Map(
        dto.accounts
          .map((a) => ({ channel: a.channel, handle: cleanHandle(a.handle) }))
          .filter((a) => a.handle)
          .map((a) => [`${a.channel}:${a.handle.toLowerCase()}`, a]),
      ).values(),
    ];
    await this.prisma.$transaction(
      unique.map((a) =>
        this.prisma.accountProfile.upsert({
          where: {
            projectId_channel_handle: {
              projectId,
              channel: a.channel,
              handle: a.handle,
            },
          },
          update: data,
          create: { projectId, ...a, ...data },
        }),
      ),
    );
    // Owned / paid are stored on each mention; recompute them for these authors' posts.
    for (let i = 0; i < unique.length; i += 100) {
      const who = unique
        .slice(i, i + 100)
        .map((a) => Prisma.sql`(m.channel = ${a.channel} AND m.authorHandle = ${a.handle})`);
      await this.prisma.$executeRaw`
        UPDATE mentions m SET ${ownedPaidSet()}
        WHERE m.projectId = ${projectId} AND (${Prisma.join(who, ' OR ')})`;
    }
    return { updated: unique.length };
  }

  @Get('settings')
  settings(@Param('projectId', ParseIntPipe) projectId: number) {
    return this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { nssIncludeNeutral: true, showNss: true },
    });
  }

  @Put('settings')
  @Roles('ADMIN')
  async updateSettings(
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: ProjectSettingsDto,
  ) {
    const saved = await this.prisma.project.update({
      where: { id: projectId },
      data: dto,
      select: { nssIncludeNeutral: true, showNss: true },
    });
    this.filters.invalidate(projectId);
    return saved;
  }
}
