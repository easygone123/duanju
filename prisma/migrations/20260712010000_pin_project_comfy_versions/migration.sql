ALTER TABLE `project_comfy_bindings`
  ADD COLUMN `imageWorkflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `videoWorkflowVersionId` VARCHAR(191) NULL;

UPDATE `project_comfy_bindings` AS binding
LEFT JOIN `comfy_workflows` AS image_workflow ON image_workflow.`id` = binding.`imageWorkflowId`
LEFT JOIN `comfy_workflows` AS video_workflow ON video_workflow.`id` = binding.`videoWorkflowId`
LEFT JOIN `comfy_workflow_versions` AS image_version
  ON image_version.`id` = image_workflow.`currentVersionId`
  AND image_version.`lastSuccessfulTestAt` IS NOT NULL
LEFT JOIN `comfy_workflow_versions` AS video_version
  ON video_version.`id` = video_workflow.`currentVersionId`
  AND video_version.`lastSuccessfulTestAt` IS NOT NULL
SET binding.`imageWorkflowVersionId` = image_version.`id`,
    binding.`videoWorkflowVersionId` = video_version.`id`;

CREATE INDEX `project_comfy_bindings_imageWorkflowVersionId_imageWorkflowId_idx`
  ON `project_comfy_bindings`(`imageWorkflowVersionId`, `imageWorkflowId`);
CREATE INDEX `project_comfy_bindings_videoWorkflowVersionId_videoWorkflowId_idx`
  ON `project_comfy_bindings`(`videoWorkflowVersionId`, `videoWorkflowId`);

ALTER TABLE `project_comfy_bindings`
  ADD CONSTRAINT `project_comfy_bindings_image_version_fkey`
    FOREIGN KEY (`imageWorkflowVersionId`, `imageWorkflowId`)
    REFERENCES `comfy_workflow_versions`(`id`, `workflowId`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `project_comfy_bindings_video_version_fkey`
    FOREIGN KEY (`videoWorkflowVersionId`, `videoWorkflowId`)
    REFERENCES `comfy_workflow_versions`(`id`, `workflowId`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
