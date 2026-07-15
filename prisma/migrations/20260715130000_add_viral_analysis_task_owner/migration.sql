ALTER TABLE `viral_replications`
  ADD COLUMN `analysisExecutionTaskId` VARCHAR(191) NULL,
  ADD INDEX `viral_replications_analysisExecutionTaskId_idx` (`analysisExecutionTaskId`);
