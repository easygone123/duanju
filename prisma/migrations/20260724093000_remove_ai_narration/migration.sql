DELETE FROM `novel_promotion_voice_lines`
WHERE `lineType` = 'narration';

DROP INDEX `novel_promotion_voice_lines_sourceKey_key`
  ON `novel_promotion_voice_lines`;

ALTER TABLE `novel_promotion_voice_lines`
  DROP COLUMN `lineType`,
  DROP COLUMN `enabled`,
  DROP COLUMN `sourceKey`;

ALTER TABLE `novel_promotion_panels`
  DROP COLUMN `narrationMode`,
  DROP COLUMN `narrationRecommended`,
  DROP COLUMN `narrationSuggestedText`,
  DROP COLUMN `narrationSuggestedEmotion`,
  DROP COLUMN `narrationText`,
  DROP COLUMN `narrationEmotion`;
