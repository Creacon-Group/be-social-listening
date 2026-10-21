-- AlterTable
ALTER TABLE `users` ADD COLUMN `dailyChatCredits` INTEGER NOT NULL DEFAULT 5,
    MODIFY `role` ENUM('SUPERADMIN', 'ADMIN', 'ANALYST', 'VIEWER') NOT NULL DEFAULT 'ANALYST';

-- CreateTable
CREATE TABLE `chat_usage` (
    `userId` INTEGER NOT NULL,
    `day` DATE NOT NULL,
    `used` INTEGER NOT NULL DEFAULT 0,
    `bonus` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`userId`, `day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `chat_usage` ADD CONSTRAINT `chat_usage_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
