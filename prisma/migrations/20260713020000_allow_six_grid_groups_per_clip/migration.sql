DROP INDEX `novel_promotion_storyboards_clipId_key`
  ON `novel_promotion_storyboards`;

DROP INDEX `novel_storyboards_episode_layout_group_idx`
  ON `novel_promotion_storyboards`;

CREATE UNIQUE INDEX `novel_storyboards_episode_layout_group_idx`
  ON `novel_promotion_storyboards`(`episodeId`, `layoutMode`, `groupSequence`);
