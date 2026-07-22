ALTER TABLE `novel_promotion_storyboards`
  ADD COLUMN `directorVideoUrl` TEXT NULL,
  ADD COLUMN `directorVideoMediaId` VARCHAR(191) NULL;

CREATE INDEX `novel_promotion_storyboards_directorVideoMediaId_idx`
  ON `novel_promotion_storyboards`(`directorVideoMediaId`);

ALTER TABLE `novel_promotion_storyboards`
  ADD CONSTRAINT `novel_promotion_storyboards_directorVideoMediaId_fkey`
    FOREIGN KEY (`directorVideoMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
