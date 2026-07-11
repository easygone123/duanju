ALTER TABLE `project_comfy_bindings`
  ADD COLUMN `imageWorkflowVersionId` VARCHAR(191) NULL,
  ADD COLUMN `videoWorkflowVersionId` VARCHAR(191) NULL;

UPDATE `project_comfy_bindings` AS binding
LEFT JOIN `projects` AS project
  ON project.`id` = binding.`projectId`
  AND project.`userId` = binding.`userId`
LEFT JOIN `comfy_workflows` AS image_workflow
  ON image_workflow.`id` = binding.`imageWorkflowId`
  AND image_workflow.`userId` = binding.`userId`
  AND image_workflow.`status` = 'published'
  AND image_workflow.`mediaType` = 'image'
LEFT JOIN `comfy_workflows` AS video_workflow
  ON video_workflow.`id` = binding.`videoWorkflowId`
  AND video_workflow.`userId` = binding.`userId`
  AND video_workflow.`status` = 'published'
  AND video_workflow.`mediaType` = 'video'
LEFT JOIN `comfy_workflow_versions` AS image_version
  ON image_version.`id` = image_workflow.`currentVersionId`
  AND image_version.`workflowId` = image_workflow.`id`
  AND image_version.`publishedAt` IS NOT NULL
  AND image_version.`lastSuccessfulTestAt` IS NOT NULL
  AND image_version.`lastTestConnectionId` IS NOT NULL
LEFT JOIN `comfy_workflow_versions` AS video_version
  ON video_version.`id` = video_workflow.`currentVersionId`
  AND video_version.`workflowId` = video_workflow.`id`
  AND video_version.`publishedAt` IS NOT NULL
  AND video_version.`lastSuccessfulTestAt` IS NOT NULL
  AND video_version.`lastTestConnectionId` IS NOT NULL
LEFT JOIN `comfy_connections` AS image_connection
  ON image_connection.`id` = image_version.`lastTestConnectionId`
  AND image_connection.`userId` = binding.`userId`
LEFT JOIN `comfy_connections` AS video_connection
  ON video_connection.`id` = video_version.`lastTestConnectionId`
  AND video_connection.`userId` = binding.`userId`
SET binding.`imageWorkflowVersionId` = CASE
      WHEN project.`id` IS NOT NULL AND image_connection.`id` IS NOT NULL THEN image_version.`id`
      ELSE NULL
    END,
    binding.`videoWorkflowVersionId` = CASE
      WHEN project.`id` IS NOT NULL AND video_connection.`id` IS NOT NULL THEN video_version.`id`
      ELSE NULL
    END;

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
