import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { type AuthUser, CurrentUser, Roles } from '../../common/auth.js';
import { ChatCreditsService } from './chat-credits.service.js';

class CreateUserDto {
  @IsEmail()
  @MaxLength(190)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsIn(['ADMIN', 'ANALYST', 'VIEWER'])
  role!: 'ADMIN' | 'ANALYST' | 'VIEWER';

  @IsString()
  @MinLength(10)
  @MaxLength(100)
  password!: string;

  @IsInt()
  @Min(0)
  @Max(1000)
  dailyChatCredits = 5;
}

class DailyLimitDto {
  @IsInt()
  @Min(0)
  @Max(1000)
  dailyChatCredits!: number;
}

class BonusDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  amount!: number;
}

@ApiTags('assistant')
@Controller()
export class CreditsController {
  constructor(private readonly credits: ChatCreditsService) {}

  /** The signed-in user's AI credits for today. */
  @Get('assistant/credits')
  mine(@CurrentUser() user: AuthUser) {
    return this.credits.status(user.id, user.role);
  }

  @Get('admin/users')
  @Roles('SUPERADMIN')
  users() {
    return this.credits.listUsers();
  }

  /** New user, added to every project (the MVP has one project per client). */
  @Post('admin/users')
  @Roles('SUPERADMIN')
  createUser(@Body() dto: CreateUserDto) {
    return this.credits.createUser(dto);
  }

  /** Permanent daily limit. */
  @Put('admin/users/:userId/credits')
  @Roles('SUPERADMIN')
  @HttpCode(204)
  async setLimit(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: DailyLimitDto,
  ) {
    await this.credits.setDailyLimit(userId, dto.dailyChatCredits);
  }

  /** Extra credits for today only. */
  @Post('admin/users/:userId/credits/bonus')
  @Roles('SUPERADMIN')
  @HttpCode(204)
  async addBonus(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: BonusDto,
  ) {
    await this.credits.addBonusToday(userId, dto.amount);
  }
}
