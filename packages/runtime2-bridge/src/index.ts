import { RuntimeController } from '../../runtime3-bridge/src/index.js';
import type { SceneEnvironment } from '../../runtime3-bridge/src/scene.js';

export class Creator2Runtime extends RuntimeController {
  constructor(environment: Omit<SceneEnvironment, 'major'>) { super({ ...environment, major: 2 }); }
}
