// Shared by tests that build real media fixtures. The server runs ffmpeg at this fixed path,
// so tests check the same path. Without it those tests skip with a clear reason instead of crashing the file.
import { existsSync } from 'node:fs';

export const FFMPEG = '/usr/bin/ffmpeg';
// On CI a missing ffmpeg must fail loudly, never turn security tests into silent skips.
export const skipNoFfmpeg = existsSync(FFMPEG) || process.env.CI ? false : `ffmpeg not found at ${FFMPEG} (install it, e.g. apt-get install ffmpeg)`;
if (skipNoFfmpeg) console.warn(`# ${skipNoFfmpeg}: media fixture tests are skipped`);
