import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FrameSession } from '../packages/runtime3-bridge/src/frame-session.js';

class FrameHarness {
  scene = {};
  resumes = 0;
  director = Object.assign(new EventEmitter(), { getScene: () => this.scene, isPaused: () => false });
  game = { isPaused: () => true, resume: () => { this.resumes++; } };
  frames = new FrameSession({ director: this.director, game: this.game, Director: { EVENT_AFTER_DRAW: 'after' } });
}
test('frame timeout reports native pause state without resuming the game and removes listeners', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new FrameHarness();
  const rejected = assert.rejects(h.frames.wait(h.frames.token()), { code: 'CONTEXT_UNAVAILABLE', details: { timeoutMs: 2000, gamePaused: true, directorPaused: false } });
  context.mock.timers.tick(2000); await rejected;
  assert.equal(h.resumes, 0); assert.equal(h.director.listenerCount('after'), 0);
});
test('unavailable pause diagnostics do not mask timeout or prevent frame listener cleanup', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const h = new FrameHarness();
  Object.defineProperty(h.game, 'isPaused', { get: () => { throw new Error('getter unavailable'); } });
  Object.defineProperty(h.director, 'isPaused', { value: undefined });
  const rejected = assert.rejects(h.frames.wait(h.frames.token()), { code: 'CONTEXT_UNAVAILABLE', details: { timeoutMs: 2000, gamePaused: null, directorPaused: null } });
  context.mock.timers.tick(2000); await rejected;
  assert.equal(h.resumes, 0); assert.equal(h.director.listenerCount('after'), 0);
});
