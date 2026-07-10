CREATE UNIQUE INDEX `projects_id_userId_key` ON `projects`(`id`, `userId`);

CREATE UNIQUE INDEX `tasks_id_userId_projectId_key` ON `tasks`(`id`, `userId`, `projectId`);

CREATE TABLE `comfy_connections` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `baseUrl` VARCHAR(191) NOT NULL,
  `normalizedBaseUrl` VARCHAR(191) NOT NULL,
  `authType` VARCHAR(191) NOT NULL DEFAULT 'none',
  `authSecretEncrypted` TEXT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `lastHealthAt` DATETIME(3) NULL,
  `lastHealthCode` VARCHAR(191) NULL,
  `lastHealthMessage` TEXT NULL,
  `lastSeenVersion` VARCHAR(191) NULL,
  `deviceSummary` JSON NULL,
  `lastAssignedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `comfy_connections_userId_normalizedBaseUrl_key`(`userId`, `normalizedBaseUrl`),
  UNIQUE INDEX `comfy_connections_id_userId_key`(`id`, `userId`),
  INDEX `comfy_connections_userId_enabled_idx`(`userId`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `comfy_workflows` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `mediaType` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'draft',
  `currentVersionId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `comfy_workflows_currentVersionId_key`(`currentVersionId`),
  UNIQUE INDEX `comfy_workflows_id_userId_key`(`id`, `userId`),
  UNIQUE INDEX `comfy_workflows_currentVersionId_id_key`(`currentVersionId`, `id`),
  INDEX `comfy_workflows_userId_status_mediaType_idx`(`userId`, `status`, `mediaType`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `comfy_workflow_versions` (
  `id` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `version` INTEGER NOT NULL,
  `apiFormatJson` JSON NOT NULL,
  `variableDefinitions` JSON NOT NULL,
  `bindingSpec` JSON NOT NULL,
  `outputSpec` JSON NOT NULL,
  `requirements` JSON NOT NULL,
  `contentHash` VARCHAR(191) NOT NULL,
  `publishedAt` DATETIME(3) NULL,
  `lastSuccessfulTestAt` DATETIME(3) NULL,
  `lastTestConnectionId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `comfy_workflow_versions_workflowId_version_key`(`workflowId`, `version`),
  UNIQUE INDEX `comfy_workflow_versions_id_workflowId_key`(`id`, `workflowId`),
  INDEX `comfy_workflow_versions_lastTestConnectionId_idx`(`lastTestConnectionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `project_comfy_bindings` (
  `projectId` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `imageWorkflowId` VARCHAR(191) NULL,
  `videoWorkflowId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `project_comfy_bindings_userId_idx`(`userId`),
  INDEX `project_comfy_bindings_imageWorkflowId_idx`(`imageWorkflowId`),
  INDEX `project_comfy_bindings_videoWorkflowId_idx`(`videoWorkflowId`),
  UNIQUE INDEX `project_comfy_bindings_projectId_userId_key`(`projectId`, `userId`),
  PRIMARY KEY (`projectId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `comfy_generation_requests` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `invocationKey` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `mediaType` VARCHAR(191) NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `workflowVersionId` VARCHAR(191) NOT NULL,
  `variableSnapshot` JSON NOT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'waiting_capacity',
  `connectionId` VARCHAR(191) NULL,
  `leaseId` VARCHAR(191) NULL,
  `leaseExpiresAt` DATETIME(3) NULL,
  `promptId` VARCHAR(191) NULL,
  `clientId` VARCHAR(191) NULL,
  `outputRefs` JSON NULL,
  `errorCode` VARCHAR(191) NULL,
  `errorMessage` TEXT NULL,
  `nodeErrors` JSON NULL,
  `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `leasedAt` DATETIME(3) NULL,
  `uploadingAt` DATETIME(3) NULL,
  `submittedAt` DATETIME(3) NULL,
  `runningAt` DATETIME(3) NULL,
  `transferringAt` DATETIME(3) NULL,
  `reconcilingAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `failedAt` DATETIME(3) NULL,
  `canceledAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `comfy_generation_requests_invocationKey_key`(`invocationKey`),
  INDEX `comfy_generation_requests_userId_status_queuedAt_idx`(`userId`, `status`, `queuedAt`),
  INDEX `comfy_generation_requests_connectionId_status_idx`(`connectionId`, `status`),
  INDEX `comfy_generation_requests_promptId_idx`(`promptId`),
  INDEX `comfy_generation_requests_taskId_idx`(`taskId`),
  INDEX `comfy_generation_requests_projectId_idx`(`projectId`),
  INDEX `comfy_generation_requests_workflowId_idx`(`workflowId`),
  INDEX `comfy_generation_requests_workflowVersionId_idx`(`workflowVersionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `comfy_connections`
  ADD CONSTRAINT `comfy_connections_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_workflows`
  ADD CONSTRAINT `comfy_workflows_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_workflow_versions`
  ADD CONSTRAINT `comfy_workflow_versions_workflowId_fkey`
  FOREIGN KEY (`workflowId`) REFERENCES `comfy_workflows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_workflow_versions`
  ADD CONSTRAINT `comfy_workflow_versions_lastTestConnectionId_fkey`
  FOREIGN KEY (`lastTestConnectionId`) REFERENCES `comfy_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `comfy_workflows`
  ADD CONSTRAINT `comfy_workflows_currentVersionId_id_fkey`
  FOREIGN KEY (`currentVersionId`, `id`) REFERENCES `comfy_workflow_versions`(`id`, `workflowId`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `project_comfy_bindings`
  ADD CONSTRAINT `project_comfy_bindings_projectId_userId_fkey`
  FOREIGN KEY (`projectId`, `userId`) REFERENCES `projects`(`id`, `userId`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `project_comfy_bindings`
  ADD CONSTRAINT `project_comfy_bindings_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `project_comfy_bindings`
  ADD CONSTRAINT `project_comfy_bindings_imageWorkflowId_userId_fkey`
  FOREIGN KEY (`imageWorkflowId`, `userId`) REFERENCES `comfy_workflows`(`id`, `userId`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `project_comfy_bindings`
  ADD CONSTRAINT `project_comfy_bindings_videoWorkflowId_userId_fkey`
  FOREIGN KEY (`videoWorkflowId`, `userId`) REFERENCES `comfy_workflows`(`id`, `userId`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_taskId_userId_projectId_fkey`
  FOREIGN KEY (`taskId`, `userId`, `projectId`) REFERENCES `tasks`(`id`, `userId`, `projectId`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_projectId_userId_fkey`
  FOREIGN KEY (`projectId`, `userId`) REFERENCES `projects`(`id`, `userId`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_workflowId_userId_fkey`
  FOREIGN KEY (`workflowId`, `userId`) REFERENCES `comfy_workflows`(`id`, `userId`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_workflowVersionId_workflowId_fkey`
  FOREIGN KEY (`workflowVersionId`, `workflowId`) REFERENCES `comfy_workflow_versions`(`id`, `workflowId`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `comfy_generation_requests`
  ADD CONSTRAINT `comfy_generation_requests_connectionId_userId_fkey`
  FOREIGN KEY (`connectionId`, `userId`) REFERENCES `comfy_connections`(`id`, `userId`) ON DELETE RESTRICT ON UPDATE CASCADE;
