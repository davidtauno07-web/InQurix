import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './log.js';

createApp().listen(config.PORT, () => log.info(`InQurix server listening on ${config.APP_URL} (port ${config.PORT})`));
