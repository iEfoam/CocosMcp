import assert from 'node:assert/strict';
import test from 'node:test';
import { AnimationController } from '../packages/runtime3-bridge/src/animation-control.js';
import { SceneInspector } from '../packages/runtime3-bridge/src/scene.js';
import { Json } from '../packages/contracts/src/index.js';
class State {
  time = 0; duration = 2; speed = 1; weight = 1; isPlaying = false; isPaused = false;
  pause(): void { if (this.isPlaying) this.isPaused = true; }
  resume(): void { this.isPaused = false; }
  stop(): void { this.isPlaying = false; this.isPaused = false; }
  setTime(time: number): void { this.time = time; }
}
class Animation {
  uuid = 'animation'; clips = [{ name: 'Walk' }]; state = new State(); commands: string[] = [];
  getState(name: string): State | null { return name === 'Walk' ? this.state : null; }
  play(name: string): void { this.commands.push(`play:${name}`); this.state.isPlaying = true; }
  crossFade(name: string, duration: number): void { this.commands.push(`blend:${name}:${duration}`); this.state.isPlaying = true; }
}
class ControlHarness {
  component = new Animation();
  root = { uuid: 'root', children: [], getComponents: () => [this.component] };
  controller = new AnimationController(new SceneInspector({ major: 3, cc: { Animation, director: { getScene: () => this.root } } }));
}
test('animation controls use public native methods and report state instead of claiming rendered playback', () => {
  const h = new ControlHarness(), p = { componentId: 'animation', name: 'Walk' };
  const played = Json.object(h.controller.execute('runtime.animation.play', p)); assert.equal(played.frameVerified, false);
  h.controller.execute('runtime.animation.pause', p); assert.equal(h.component.state.isPaused, true);
  h.controller.execute('runtime.animation.seek', { ...p, time: 1 }); assert.equal(h.component.state.time, 1);
  h.controller.execute('runtime.animation.resume', p); assert.equal(h.component.state.isPaused, false);
  h.controller.execute('runtime.animation.blend', { ...p, duration: 0.5 });
  h.controller.execute('runtime.animation.stop', p); assert.equal(h.component.state.isPlaying, false);
  assert.deepEqual(h.component.commands, ['play:Walk', 'blend:Walk:0.5']);
  assert.equal(Json.object(h.controller.execute('runtime.animation.state', { componentId: 'animation' })).scope, 'native-animation-states');
});
test('animation control validates target, timing and duplicate clip names before sending commands', () => {
  const h = new ControlHarness();
  assert.throws(() => h.controller.execute('runtime.animation.play', { componentId: 'animation', name: 'Missing' }), /unavailable/);
  assert.throws(() => h.controller.execute('runtime.animation.seek', { componentId: 'animation', name: 'Walk', time: 3 }), /duration/);
  h.component.clips.push({ name: 'Walk' });
  assert.throws(() => h.controller.execute('runtime.animation.play', { componentId: 'animation', name: 'Walk' }), /ambiguous/); assert.deepEqual(h.component.commands, []);
});
