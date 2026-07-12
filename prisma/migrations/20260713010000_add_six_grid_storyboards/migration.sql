ALTER TABLE `novel_promotion_projects`
  ADD COLUMN `storyboardGenerationMode` VARCHAR(191) NOT NULL DEFAULT 'individual',
  ADD COLUMN `sixGridCellAspectRatio` VARCHAR(191) NULL,
  ADD COLUMN `sixGridProcessingOrder` VARCHAR(191) NOT NULL DEFAULT 'crop_then_panel_upscale',
  ADD COLUMN `storyboardUpscaleModel` VARCHAR(191) NULL,
  ADD COLUMN `dialogueVideoModel` VARCHAR(191) NULL;

ALTER TABLE `novel_promotion_storyboards`
  ADD COLUMN `layoutMode` VARCHAR(191) NOT NULL DEFAULT 'individual',
  ADD COLUMN `groupSequence` INTEGER NULL,
  ADD COLUMN `continuityAnchor` TEXT NULL,
  ADD COLUMN `sixGridCellAspectRatio` VARCHAR(191) NULL,
  ADD COLUMN `sixGridProcessingOrder` VARCHAR(191) NULL,
  ADD COLUMN `sheetImageUrl` TEXT NULL,
  ADD COLUMN `sheetImageMediaId` VARCHAR(191) NULL,
  ADD COLUMN `upscaledSheetImageUrl` TEXT NULL,
  ADD COLUMN `upscaledSheetImageMediaId` VARCHAR(191) NULL,
  ADD COLUMN `sheetPromptSnapshot` TEXT NULL,
  ADD COLUMN `sheetModelSnapshot` TEXT NULL,
  ADD COLUMN `sheetGenerationOptionsSnapshot` TEXT NULL,
  ADD COLUMN `sheetArtifactVersion` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `novel_promotion_panels`
  ADD COLUMN `gridCellIndex` INTEGER NULL,
  ADD COLUMN `normalizedCropRect` TEXT NULL,
  ADD COLUMN `croppedImageUrl` TEXT NULL,
  ADD COLUMN `croppedImageMediaId` VARCHAR(191) NULL,
  ADD COLUMN `upscaledImageUrl` TEXT NULL,
  ADD COLUMN `upscaledImageMediaId` VARCHAR(191) NULL,
  ADD COLUMN `imageDerivation` TEXT NULL,
  ADD COLUMN `imageLineage` TEXT NULL,
  ADD COLUMN `hasDialogue` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `dialogueSpeaker` VARCHAR(191) NULL,
  ADD COLUMN `dialogueText` TEXT NULL,
  ADD COLUMN `dialogueEmotion` VARCHAR(191) NULL,
  ADD COLUMN `includeDialogueInVideoPrompt` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `estimatedDuration` DOUBLE NULL,
  ADD COLUMN `durationOverride` DOUBLE NULL,
  ADD COLUMN `firstFrameSourceMeta` TEXT NULL,
  ADD COLUMN `lastFrameSourceMeta` TEXT NULL;

CREATE INDEX `novel_storyboards_episode_layout_group_idx`
  ON `novel_promotion_storyboards`(`episodeId`, `layoutMode`, `groupSequence`);
CREATE INDEX `novel_promotion_storyboards_sheetImageMediaId_idx`
  ON `novel_promotion_storyboards`(`sheetImageMediaId`);
CREATE INDEX `novel_promotion_storyboards_upscaledSheetImageMediaId_idx`
  ON `novel_promotion_storyboards`(`upscaledSheetImageMediaId`);
CREATE INDEX `novel_promotion_panels_croppedImageMediaId_idx`
  ON `novel_promotion_panels`(`croppedImageMediaId`);
CREATE INDEX `novel_promotion_panels_upscaledImageMediaId_idx`
  ON `novel_promotion_panels`(`upscaledImageMediaId`);

ALTER TABLE `novel_promotion_storyboards`
  ADD CONSTRAINT `novel_promotion_storyboards_sheetImageMediaId_fkey`
    FOREIGN KEY (`sheetImageMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `novel_promotion_storyboards_upscaledSheetImageMediaId_fkey`
    FOREIGN KEY (`upscaledSheetImageMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `novel_promotion_panels`
  ADD CONSTRAINT `novel_promotion_panels_croppedImageMediaId_fkey`
    FOREIGN KEY (`croppedImageMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `novel_promotion_panels_upscaledImageMediaId_fkey`
    FOREIGN KEY (`upscaledImageMediaId`) REFERENCES `media_objects`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
