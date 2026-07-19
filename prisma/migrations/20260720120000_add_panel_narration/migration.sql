ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `narrationMode` VARCHAR(191) NOT NULL DEFAULT 'auto',
  ADD COLUMN `narrationRecommended` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `narrationSuggestedText` TEXT NULL,
  ADD COLUMN `narrationSuggestedEmotion` VARCHAR(191) NULL,
  ADD COLUMN `narrationText` TEXT NULL,
  ADD COLUMN `narrationEmotion` VARCHAR(191) NULL;

ALTER TABLE `novel_promotion_voice_lines`
  ADD COLUMN `lineType` VARCHAR(191) NOT NULL DEFAULT 'dialogue',
  ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `sourceKey` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `novel_promotion_voice_lines_sourceKey_key`
  ON `novel_promotion_voice_lines`(`sourceKey`);
