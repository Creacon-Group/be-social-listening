import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ALL_PERMISSIONS } from '../../common/permissions.js';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export class BrandDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsBoolean() isOwn!: boolean;
  @IsOptional() @Matches(HEX) color?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  aliases?: string[];
}

export class UpdateBrandDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() isOwn?: boolean;
  @IsOptional() @Matches(HEX) color?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  aliases?: string[];
}

export class CreateProjectDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsString()
  @MaxLength(120)
  @Matches(SLUG, { message: 'slug: lowercase letters, numbers and dashes' })
  slug!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsString() @MaxLength(200) clientName?: string | null;

  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => BrandDto)
  brands: BrandDto[] = [];

  /** Users to add right away, with their role preset. */
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  memberIds?: number[];
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(SLUG, { message: 'slug: lowercase letters, numbers and dashes' })
  slug?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsString() @MaxLength(200) clientName?: string | null;
}

export class MemberDto {
  /** null = follow the user's role preset. */
  @IsOptional()
  @IsArray()
  @IsIn(ALL_PERMISSIONS, { each: true })
  permissions?: string[] | null;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['ADMIN', 'ANALYST', 'VIEWER']) role?:
    'ADMIN' | 'ANALYST' | 'VIEWER';
}

export class AssignKeywordDto {
  @IsString() @MinLength(1) @MaxLength(191) keyword!: string;
  @IsInt() brandId!: number;
}

export class IgnoreKeywordDto {
  @IsString() @MinLength(1) @MaxLength(191) keyword!: string;
  @IsBoolean() ignored!: boolean;
}
