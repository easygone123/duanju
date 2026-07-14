CREATE TABLE `viral_replications` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NULL,
  `episodeId` VARCHAR(191) NULL,
  `sourceVideoMediaId` VARCHAR(191) NULL,
  `brief` TEXT NOT NULL,
  `videoRatio` VARCHAR(191) NOT NULL,
  `artStyle` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'uploading',
  `analysisModelSnapshot` VARCHAR(191) NULL,
  `durationMs` INTEGER NULL,
  `transcriptText` LONGTEXT NULL,
  `reportJson` JSON NULL,
  `reportVersion` INTEGER NOT NULL DEFAULT 1,
  `errorMessage` TEXT NULL,
  `confirmedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `viral_replications_projectId_key`(`projectId`),
  UNIQUE INDEX `viral_replications_episodeId_key`(`episodeId`),
  UNIQUE INDEX `viral_replications_sourceVideoMediaId_key`(`sourceVideoMediaId`),
  INDEX `viral_replications_userId_createdAt_idx`(`userId`, `createdAt`),
  INDEX `viral_replications_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `viral_replication_frames` (
  `id` VARCHAR(191) NOT NULL,
  `replicationId` VARCHAR(191) NOT NULL,
  `mediaId` VARCHAR(191) NOT NULL,
  `shotIndex` INTEGER NOT NULL,
  `timestampMs` INTEGER NOT NULL,
  `startMs` INTEGER NOT NULL,
  `endMs` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `viral_replication_frames_replicationId_shotIndex_key`(`replicationId`, `shotIndex`),
  INDEX `viral_replication_frames_replicationId_idx`(`replicationId`),
  INDEX `viral_replication_frames_mediaId_idx`(`mediaId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `viral_replications`
  ADD CONSTRAINT `viral_replications_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `user`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `viral_replications_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `viral_replications_episodeId_fkey`
    FOREIGN KEY (`episodeId`) REFERENCES `novel_promotion_episodes`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `viral_replications_sourceVideoMediaId_fkey`
    FOREIGN KEY (`sourceVideoMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `viral_replication_frames`
  ADD CONSTRAINT `viral_replication_frames_replicationId_fkey`
    FOREIGN KEY (`replicationId`) REFERENCES `viral_replications`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `viral_replication_frames_mediaId_fkey`
    FOREIGN KEY (`mediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
