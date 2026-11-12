-- Per-project permissions. NULL = follow the user's role preset (no behaviour change for existing members).
ALTER TABLE `project_members`
  ADD COLUMN `permissions` JSON NULL,
  ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
