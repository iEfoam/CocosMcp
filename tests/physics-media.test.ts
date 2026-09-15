import assert from 'node:assert/strict';
import test from 'node:test';
import { PhysicsQueries } from '../packages/runtime3-bridge/src/physics.js';
import { MediaController } from '../packages/runtime3-bridge/src/media.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Json, type JsonObject } from '../packages/contracts/src/index.js';
class Vector { constructor(public x: number, public y: number, public z = 0) {} }
class Ray { constructor(...values: number[]) { assert.deepEqual(values, [0, 0, 0, 0, 0, 1]); } }
class AudioSource {
  uuid = 'audio'; duration = 10; currentTime = 0; state = 'ready'; enabledInHierarchy = true; commands: string[] = [];
  play(): void { this.commands.push('play'); this.state = 'playing'; }
  pause(): void { this.commands.push('pause'); this.state = 'paused'; }
  stop(): void { this.commands.push('stop'); this.state = 'stopped'; }
}
class VideoPlayer extends AudioSource { override uuid = 'video'; }
class WebView { uuid = 'web'; enabledInHierarchy = true; url = 'https://private.invalid/?token=secret'; }

test('physics rays validate bounds, normalize 3D direction and copy sorted pooled results', () => {
  const hit = { collider: { uuid: 'c', node: { uuid: 'n' } }, distance: 2, hitPoint: new Vector(0, 0, 2), hitNormal: new Vector(0, 0, -1) };
  let calls = 0;
  const queries = new PhysicsQueries({ geometry: { Ray }, Vec2: Vector, PhysicsSystem: { instance: { enable: true, gravity: new Vector(0, -10), raycast: () => { calls++; return true; }, raycastResults: [hit] } },
    PhysicsSystem2D: { instance: { enable: true, gravity: new Vector(0, -10), raycast: (_a: Vector, _b: Vector, type: number) => { assert.equal(type, 3); return [{ collider: hit.collider, point: new Vector(5, 0), normal: new Vector(0, 1), fraction: 0.5 }]; } } } });
  const p = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 5 } };
  const result = Json.object(queries.execute('runtime.physics3d.raycast', p)); hit.hitPoint.z = 90;
  assert.equal(Json.object((result.rows as JsonObject[])[0]!.point).z, 2); assert.equal(calls, 1);
  assert.throws(() => queries.execute('runtime.physics3d.raycast', { ...p, direction: { x: 0, y: 0, z: 0 } }), /direction/); assert.equal(calls, 1);
  const result2d = Json.object(queries.execute('runtime.physics2d.raycast', { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } })); assert.equal((result2d.rows as JsonObject[])[0]!.distance, 5);
  assert.equal(Json.object(queries.execute('runtime.physics3d.inspect', {})).enabled, true);
  assert.throws(() => new PhysicsQueries({}).execute('runtime.physics2d.inspect', {}), /not available/);
});
test('media controls validate component type and duration; WebView inspection does not expose navigation credentials', () => {
  const audio = new AudioSource(), video = new VideoPlayer(), web = new WebView();
  const root = { uuid: 'root', children: [], getComponents: () => [audio, video, web] };
  const media = new MediaController(new SceneInspector({ major: 3, cc: { AudioSource, VideoPlayer, WebView, director: { getScene: () => root } } }));
  for (const [kind, component] of [['audio', audio], ['video', video]] as const) {
    const p = { componentId: component.uuid };
    assert.equal(Json.object(media.execute(`runtime.${kind}.state`, p)).progressVerified, false);
    media.execute(`runtime.${kind}.play`, p); media.execute(`runtime.${kind}.pause`, p); media.execute(`runtime.${kind}.seek`, { ...p, time: 3 }); media.execute(`runtime.${kind}.stop`, p);
    assert.deepEqual(component.commands, ['play', 'pause', 'stop']); assert.equal(component.currentTime, 3);
    assert.throws(() => media.execute(`runtime.${kind}.seek`, { ...p, time: 11 }), /duration/);
  }
  assert.throws(() => media.execute('runtime.video.play', { componentId: 'audio' }), /not VideoPlayer/);
  assert.throws(() => media.execute('runtime.webview.navigate', { componentId: 'web' }), /Unknown media capability/);
  const webpage = media.execute('runtime.webview.inspect', { componentId: 'web' }); assert.ok(!JSON.stringify(webpage).includes('secret'));
});
