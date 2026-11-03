-- Net Sentiment formula per project
ALTER TABLE `projects` ADD COLUMN `nssIncludeNeutral` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `showNss` BOOLEAN NOT NULL DEFAULT true;

-- Manual account classification (KOL / Media / Official / Other, paid vs organic)
CREATE TABLE `account_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `channel` ENUM('X', 'TIKTOK', 'INSTAGRAM', 'ONLINE_NEWS', 'FACEBOOK', 'YOUTUBE', 'BLOG') NOT NULL,
    `handle` VARCHAR(150) NOT NULL,
    `accountType` ENUM('KOL', 'MEDIA', 'OFFICIAL', 'OTHER') NULL,
    `isPaid` BOOLEAN NULL,
    `updatedById` INTEGER NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `account_profiles_projectId_channel_handle_key`(`projectId`, `channel`, `handle`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `account_profiles` ADD CONSTRAINT `account_profiles_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
