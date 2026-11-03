-- GEO Intelligence settings per project and owned domains per brand
ALTER TABLE `projects` ADD COLUMN `geoEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `geoRunDay` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `geoRunsPerPrompt` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `geoProfile` JSON NULL;

ALTER TABLE `brands` ADD COLUMN `domains` JSON NULL;

CREATE TABLE `geo_prompts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `category` ENUM('CATEGORY_DISCOVERY', 'BRAND_RECOMMENDATION', 'PROBLEM_SOLUTION', 'BRAND_COMPARISON', 'BRAND_AWARENESS', 'BRAND_REPUTATION') NOT NULL,
    `branded` BOOLEAN NOT NULL DEFAULT false,
    `language` VARCHAR(10) NOT NULL DEFAULT 'id',
    `status` ENUM('DRAFT', 'APPROVED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `source` VARCHAR(20) NOT NULL DEFAULT 'manual',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `geo_prompts_projectId_status_idx`(`projectId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_prompt_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `promptId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `text` TEXT NOT NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `geo_prompt_versions_promptId_version_key`(`promptId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_batches` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `period` VARCHAR(7) NOT NULL,
    `status` ENUM('RUNNING', 'PAUSED', 'COMPLETED', 'PARTIAL', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `trigger` VARCHAR(20) NOT NULL,
    `config` JSON NOT NULL,
    `total` INTEGER NOT NULL DEFAULT 0,
    `succeeded` INTEGER NOT NULL DEFAULT 0,
    `failed` INTEGER NOT NULL DEFAULT 0,
    `createdById` INTEGER NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `geo_batches_projectId_period_key`(`projectId`, `period`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchId` INTEGER NOT NULL,
    `projectId` INTEGER NOT NULL,
    `promptVersionId` INTEGER NOT NULL,
    `model` VARCHAR(100) NOT NULL,
    `mode` ENUM('KNOWLEDGE', 'SEARCH') NOT NULL,
    `runNo` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `latencyMs` INTEGER NULL,
    `promptTokens` INTEGER NULL,
    `completionTokens` INTEGER NULL,
    `reasoningTokens` INTEGER NULL,
    `requestId` VARCHAR(120) NULL,
    `errorType` VARCHAR(60) NULL,
    `errorMessage` VARCHAR(500) NULL,
    `rawResponse` JSON NULL,
    `text` MEDIUMTEXT NULL,
    `executedAt` DATETIME(3) NULL,

    INDEX `geo_runs_projectId_status_idx`(`projectId`, `status`),
    UNIQUE INDEX `geo_runs_batchId_promptVersionId_model_mode_runNo_key`(`batchId`, `promptVersionId`, `model`, `mode`, `runNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_citations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `url` VARCHAR(1000) NOT NULL,
    `startIndex` INTEGER NULL,
    `endIndex` INTEGER NULL,
    `ownedBy` VARCHAR(20) NULL,

    INDEX `geo_citations_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_evaluations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `runId` INTEGER NOT NULL,
    `version` VARCHAR(20) NOT NULL,
    `evaluatorModel` VARCHAR(100) NULL,
    `status` VARCHAR(20) NOT NULL,
    `error` VARCHAR(500) NULL,
    `raw` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `geo_evaluations_runId_createdAt_idx`(`runId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `geo_brand_results` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `evaluationId` INTEGER NOT NULL,
    `isTarget` BOOLEAN NOT NULL,
    `brandId` INTEGER NULL,
    `name` VARCHAR(120) NOT NULL,
    `mentioned` BOOLEAN NOT NULL,
    `matches` JSON NULL,
    `recommendation` ENUM('RECOMMENDED', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'NOT_MENTIONED', 'UNCLEAR') NOT NULL,
    `position` INTEGER NULL,
    `listSize` INTEGER NULL,
    `sentiment` VARCHAR(10) NULL,
    `evidence` VARCHAR(600) NULL,
    `manual` BOOLEAN NOT NULL DEFAULT false,

    INDEX `geo_brand_results_evaluationId_idx`(`evaluationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `geo_prompts` ADD CONSTRAINT `geo_prompts_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_prompt_versions` ADD CONSTRAINT `geo_prompt_versions_promptId_fkey` FOREIGN KEY (`promptId`) REFERENCES `geo_prompts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_batches` ADD CONSTRAINT `geo_batches_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_runs` ADD CONSTRAINT `geo_runs_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `geo_batches`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_runs` ADD CONSTRAINT `geo_runs_promptVersionId_fkey` FOREIGN KEY (`promptVersionId`) REFERENCES `geo_prompt_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `geo_citations` ADD CONSTRAINT `geo_citations_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `geo_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_evaluations` ADD CONSTRAINT `geo_evaluations_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `geo_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `geo_brand_results` ADD CONSTRAINT `geo_brand_results_evaluationId_fkey` FOREIGN KEY (`evaluationId`) REFERENCES `geo_evaluations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
