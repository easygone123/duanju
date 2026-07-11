ALTER TABLE `comfy_generation_requests`
  ADD COLUMN `cancelRequestedAt` DATETIME(3) NULL,
  ADD COLUMN `submittingAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `comfy_generation_requests_id_userId_key`
  ON `comfy_generation_requests`(`id`, `userId`);

CREATE TABLE `comfy_submission_attempts` (
  `id` VARCHAR(191) NOT NULL,
  `requestId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `connectionId` VARCHAR(191) NOT NULL,
  `leaseId` VARCHAR(191) NOT NULL,
  `clientId` VARCHAR(191) NOT NULL,
  `promptId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'fenced',
  `acceptedAt` DATETIME(3) NULL,
  `firstCheckedAt` DATETIME(3) NULL,
  `lastCheckedAt` DATETIME(3) NULL,
  `checkCount` INTEGER NOT NULL DEFAULT 0,
  `reconcileDeadlineAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `comfy_submission_attempts_clientId_key`(`clientId`),
  UNIQUE INDEX `comfy_submission_attempts_connectionId_promptId_key`(`connectionId`, `promptId`),
  INDEX `comfy_submission_attempts_requestId_createdAt_idx`(`requestId`, `createdAt`),
  INDEX `comfy_submission_attempts_connectionId_status_idx`(`connectionId`, `status`),
  INDEX `comfy_submission_attempts_userId_status_idx`(`userId`, `status`),
  CONSTRAINT `comfy_submission_attempts_requestId_userId_fkey`
    FOREIGN KEY (`requestId`, `userId`) REFERENCES `comfy_generation_requests`(`id`, `userId`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `comfy_submission_attempts_connectionId_userId_fkey`
    FOREIGN KEY (`connectionId`, `userId`) REFERENCES `comfy_connections`(`id`, `userId`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
