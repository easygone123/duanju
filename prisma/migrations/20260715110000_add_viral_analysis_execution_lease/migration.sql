ALTER TABLE `viral_replications`
  ADD COLUMN `analysisExecutionToken` VARCHAR(191) NULL,
  ADD COLUMN `analysisExecutionExpiresAt` DATETIME(3) NULL,
  ADD INDEX `viral_replications_analysisExecutionExpiresAt_idx` (`analysisExecutionExpiresAt`);
