-- Manual (ad-hoc) GEO runs paid with AI credits: no period, so they never block the monthly run.
ALTER TABLE `geo_batches` MODIFY `period` VARCHAR(7) NULL,
    ADD COLUMN `kind` VARCHAR(10) NOT NULL DEFAULT 'monthly',
    ADD COLUMN `label` VARCHAR(120) NULL;
