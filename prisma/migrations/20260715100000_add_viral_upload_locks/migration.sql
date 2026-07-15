ALTER TABLE `viral_replications`
  ADD COLUMN `uploadLockToken` VARCHAR(191) NULL,
  ADD COLUMN `uploadLockExpiresAt` DATETIME(3) NULL;
