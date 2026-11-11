-- Dashboard performance: values the aggregates used to compute per row from JSON and from
-- account_profiles are stored as plain columns, plus a covering index for the totals.
-- Existing rows are filled by `npm run db:backfill-derived` (batched), not here, so this
-- migration stays a quick metadata change on TiDB.
ALTER TABLE `mentions`
    ADD COLUMN `isOwned` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `isPaid` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `tierRank` TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN `gender` VARCHAR(50) NULL,
    ADD COLUMN `province` VARCHAR(50) NULL,
    ADD COLUMN `country` VARCHAR(100) NULL,
    ADD COLUMN `bookmarks` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactLove` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactWow` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactHaha` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactSad` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactAngry` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `reactFavorites` INTEGER NOT NULL DEFAULT 0;

CREATE INDEX `mentions_agg_idx` ON `mentions`(`projectId`, `publishedAt`, `channel`, `sentimentLabel`, `isOwned`, `isPaid`, `engagements`, `reach`, `views`);

CREATE INDEX `mentions_author_idx` ON `mentions`(`projectId`, `authorHandle`);
