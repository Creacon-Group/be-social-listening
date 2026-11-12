-- AlterTable
ALTER TABLE `projects` ADD COLUMN `ignoredKeywords` JSON NULL;

-- CreateTable
CREATE TABLE `mention_keywords` (
    `mentionId` INTEGER NOT NULL,
    `projectId` INTEGER NOT NULL,
    `keyword` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,

    INDEX `mention_keywords_projectId_keyword_idx`(`projectId`, `keyword`),
    PRIMARY KEY (`mentionId`, `keyword`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `mention_keywords` ADD CONSTRAINT `mention_keywords_mentionId_fkey` FOREIGN KEY (`mentionId`) REFERENCES `mentions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the keywords already kept in mentions.extra.keywords (up to 30 per mention).
INSERT IGNORE INTO `mention_keywords` (`mentionId`, `projectId`, `keyword`, `label`)
SELECT m.`id`, m.`projectId`,
       LOWER(LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(m.`extra`, CONCAT('$.keywords[', n.i, ']')))), 191)),
       LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(m.`extra`, CONCAT('$.keywords[', n.i, ']')))), 191)
FROM `mentions` m
JOIN (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5
      UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10 UNION ALL SELECT 11
      UNION ALL SELECT 12 UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15 UNION ALL SELECT 16 UNION ALL SELECT 17
      UNION ALL SELECT 18 UNION ALL SELECT 19 UNION ALL SELECT 20 UNION ALL SELECT 21 UNION ALL SELECT 22 UNION ALL SELECT 23
      UNION ALL SELECT 24 UNION ALL SELECT 25 UNION ALL SELECT 26 UNION ALL SELECT 27 UNION ALL SELECT 28 UNION ALL SELECT 29) n
  ON n.i < JSON_LENGTH(m.`extra`, '$.keywords')
WHERE JSON_TYPE(JSON_EXTRACT(m.`extra`, '$.keywords')) = 'ARRAY'
  AND TRIM(JSON_UNQUOTE(JSON_EXTRACT(m.`extra`, CONCAT('$.keywords[', n.i, ']')))) <> '';
