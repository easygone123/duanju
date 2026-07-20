CREATE TABLE `media_cleanup_candidates` (
  `id` VARCHAR(191) NOT NULL,
  `storageKey` VARCHAR(512) NOT NULL,
  `mediaId` VARCHAR(191) NULL,
  `mediaKind` VARCHAR(191) NOT NULL DEFAULT 'unknown',
  `reason` VARCHAR(191) NOT NULL,
  `notBefore` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `media_cleanup_candidates_storageKey_key`(`storageKey`),
  INDEX `media_cleanup_candidates_notBefore_idx`(`notBefore`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
