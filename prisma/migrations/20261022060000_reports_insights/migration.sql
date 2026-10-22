-- AlterTable
ALTER TABLE `projects` ADD COLUMN `clientName` VARCHAR(200) NULL,
    ADD COLUMN `lastMonthlyReport` VARCHAR(7) NULL,
    ADD COLUMN `monthlyReportDay` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `monthlyReportEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `reportRecipients` JSON NULL;

-- CreateTable
CREATE TABLE `ai_insights` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `periodFrom` DATE NOT NULL,
    `periodTo` DATE NOT NULL,
    `filter` JSON NOT NULL,
    `headline` VARCHAR(500) NOT NULL,
    `findings` JSON NOT NULL,
    `model` VARCHAR(100) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ai_insights_projectId_periodFrom_periodTo_idx`(`projectId`, `periodFrom`, `periodTo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_insights` ADD CONSTRAINT `ai_insights_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
