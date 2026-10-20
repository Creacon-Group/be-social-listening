import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import bcrypt from 'bcryptjs';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import {
  AUTH_COOKIE,
  type AuthUser,
  CurrentUser,
  Public,
} from '../../common/auth.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../database/prisma.service.js';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MaxLength(200) password!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Email atau password salah');
    }
    const expiresIn = this.config.get('JWT_EXPIRES_IN_SECONDS', {
      infer: true,
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      { expiresIn },
    );
    res.cookie(AUTH_COOKIE, accessToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'lax',
      maxAge: expiresIn * 1000,
      path: '/',
    });
    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/' });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
