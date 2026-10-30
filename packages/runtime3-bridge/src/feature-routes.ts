import { GraphicsInspector } from './graphics.js';
import { TwoDInspector } from './two-d-inspector.js';
import { PathSampler } from './path.js';
import { SkinningCompatibility } from './skinning-compatibility.js';
import { AnimationGraphObserver } from './animation-graph.js';
import { EngineFeatureInspector } from './engine-inspector.js';
import { ParticleController } from './particle.js';
import { PhysicsQueries } from './physics.js';
import { MediaController } from './media.js';
import { AnimationController } from './animation-control.js';
import { CocosError, Json, type JsonObject, type JsonValue } from '../../contracts/src/index.js';
import { RuntimeAccess as A } from './access.js';
import { FeatureSupport } from './feature-support.js';
import { TwoDControl } from './two-d-control.js';
import type { FrameSession } from './frame-session.js';
import type { SceneInspector } from './scene.js';
import type { DebugOverlayController } from './debug-overlay.js';

/** 引擎专项能力路由；帧、调试对象及其清理仍归同一个 RuntimeController 会话所有。 */
export class RuntimeFeatureRoutes {
  constructor(private readonly inspector: SceneInspector, private readonly frames: FrameSession, private readonly debug: DebugOverlayController) {}
  private get environment() { return this.inspector.environment; }
  owns(id: string): boolean {
    return /^runtime\.(ui|render2d|label|atlas|spine|tilemap|graphics|particle[23]d|physics[23]d|audio|video|webview|animation)\./.test(id) || FeatureSupport.owns(id);
  }
  async execute(id: string, p: JsonObject): Promise<JsonValue> {
    if (/^runtime\.(ui|render2d|label|atlas|spine|tilemap)\./.test(id) || id === 'runtime.physics2d.trace_contacts') return FeatureSupport.run(id, A.engineVersion(this.environment.cc), async () => {
      const control = new TwoDControl(this.inspector, this.frames);
      if (id.startsWith('runtime.spine.')) return control.spine(id, p);
      if (id.startsWith('runtime.tilemap.')) return control.tilemap(id, p);
      if (id === 'runtime.physics2d.trace_contacts') return control.contacts(p);
      return new TwoDInspector(this.inspector).execute(id, p);
    });
    if (FeatureSupport.owns(id)) return FeatureSupport.run(id, A.engineVersion(this.environment.cc), async () => {
      if (id.startsWith('runtime.debug.')) return this.debug.execute(id, p);
      if (id === 'runtime.skinning.plan') return new SkinningCompatibility(this.inspector).plan(p);
      if (id.startsWith('runtime.animation_graph.')) return new AnimationGraphObserver(this.inspector, this.frames).execute(id, p);
      if (id === 'runtime.path.preview') {
        const sampled = new PathSampler(this.environment.cc).sample(p), parent = this.inspector.node(Json.string(p.parentId, 'parentId'));
        const vector = FeatureSupport.require(this.environment.cc.Vec3, 'Vec3'); FeatureSupport.methods(vector, ['transformMat4']);
        const points = (sampled.rows as JsonObject[]).map(row => { const value = Json.object(row.position), v = A.construct(vector, [value.x, value.y, value.z]); return A.safeData(A.call(vector, 'transformMat4', v, v, parent.worldMatrix)); });
        return this.debug.execute('runtime.debug.draw', { ...p, lines: points.slice(1).map((point, index) => ({ start: points[index]!, end: point })) });
      }
      const inspector = new EngineFeatureInspector(this.inspector, this.frames);
      if (id === 'runtime.probe.preview') {
        const points=inspector.probePoints(p);
        const drawing=Json.object(this.debug.execute('runtime.debug.shape',{...p,shape:{kind:'points',points:points.rows!,radius:p.radius??0.05}}));
        return {...drawing,...points};
      }
      if (id === 'runtime.postprocess.inspect') return inspector.postprocess(p);
      if (id === 'runtime.character.test_route') return inspector.route(p);
      return inspector.inspect(id.split('.')[1]!, p);
    });
    if (id.startsWith('runtime.graphics.') || /^runtime\.particle[23]d\./.test(id)) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Graphics and particle tools require Creator 3.8.8');
      return id.startsWith('runtime.graphics.') ? new GraphicsInspector(this.environment.cc).execute(id, p) : new ParticleController(this.inspector).execute(id, p);
    }
    if (/^runtime\.(physics[23]d|audio|video|webview)\./.test(id)) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Physics and media tools require Creator 3.8.8');
      return id.startsWith('runtime.physics') ? new PhysicsQueries(this.environment.cc).execute(id, p) : new MediaController(this.inspector).execute(id, p);
    }
    if (id.startsWith('runtime.animation.')) {
      if (this.environment.major !== 3 || A.engineVersion(this.environment.cc) !== '3.8.8') throw new CocosError('UNSUPPORTED_VERSION', 'Animation controls require Creator 3.8.8');
      return new AnimationController(this.inspector).execute(id, p);
    }
    throw new CocosError('UNSUPPORTED_CAPABILITY', `No runtime feature route for ${id}`);
  }
}
