ALTER TABLE `comfy_workflow_versions`
  ADD COLUMN `purpose` VARCHAR(191) NOT NULL DEFAULT 'generation';
