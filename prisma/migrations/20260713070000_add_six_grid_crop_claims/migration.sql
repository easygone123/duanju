CREATE TABLE `six_grid_crop_claims` (
  `id` VARCHAR(191) NOT NULL,
  `claimKey` VARCHAR(512) NOT NULL,
  `ownerToken` VARCHAR(191) NOT NULL,
  `leaseUntil` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `six_grid_crop_claims_claimKey_key`(`claimKey`),
  INDEX `six_grid_crop_claims_leaseUntil_idx`(`leaseUntil`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
