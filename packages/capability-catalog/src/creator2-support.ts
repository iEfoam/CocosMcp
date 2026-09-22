/** 显式登记已接线入口；目录新增操作不得自动提升 Creator 2 的支持范围。 */
export class Creator2Support {
  static readonly base = [
    'editor.status', 'editor.environment', 'scene.query', 'scene.snapshot', 'scene.diff', 'scene.hierarchy', 'scene.validate',
    'scene.open', 'scene.create', 'scene.save', 'scene.save_copy', 'scene.close', 'scene.undo', 'scene.redo',
    'node.find', 'node.query', 'node.create', 'node.delete', 'node.duplicate', 'node.reparent', 'node.set', 'node.reset',
    'component.types', 'component.add', 'component.query', 'component.delete', 'component.set', 'component.reset', 'component.invoke',
    'prefab.create', 'prefab.instantiate', 'prefab.apply', 'prefab.revert', 'prefab.unlink',
    'asset.query', 'asset.info', 'asset.meta', 'asset.create', 'asset.save', 'asset.import', 'asset.move', 'asset.copy', 'asset.delete',
    'asset.refresh', 'asset.reimport', 'asset.set_meta', 'asset.resolve', 'asset.location', 'asset.organize.plan', 'asset.organize.apply',
    'asset.dependencies', 'asset.users', 'selection.query', 'selection.set', 'logs.query',
  ];
  static readonly scene = ['asset.references.audit', 'scene.references', 'ui.structure.plan', 'ui.structure.apply', 'shader.environment', 'shader.read', 'shader.create', 'shader.update', 'shader.restore', 'shader.inspect', 'material.update', 'material.apply_runtime', 'material.migrate', 'material.bindings', 'material.query', 'material.create', 'material.clone', 'material.properties', 'material.defines', 'material.states', 'material.assign', 'animation.clip.patch', 'animation.clip.restore', 'animation.clip.read', 'animation.clip.create', 'animation.clip.inspect', 'animation.clip.sample', 'animation2d.plan', 'animation2d.create', 'texture.inspect', 'texture.plan_import', 'texture.apply_import', 'texture.restore_import', 'spriteframe.inspect', 'spriteframe.plan', 'spriteframe.apply', 'spriteframe.restore', 'view.query', 'view.set', 'ui.plan', 'ui.build', 'ui.diff', 'ui.apply', 'ui.inspect_layout', 'ui.validate_interaction'];
  static readonly preview = ['preview.start', 'preview.stop', 'preview.status', 'preview.capture', 'preview.logs', 'preview.resize', 'preview.input', 'preview.validate_viewports', 'shader.preview.connect'];
  static readonly features = ['runtime.dragonbones.fade', 'runtime.spine.mix.inspect', 'runtime.spine.mix.update', 'runtime.dragonbones.details', 'runtime.spine.details', 'runtime.camera.sample_pixels', 'runtime.camera.inspect', 'runtime.camera.convert', 'runtime.camera.culling', 'runtime.resources.trend', 'runtime.resources.snapshot', 'runtime.resources.diff', 'runtime.collision2d.inspect', 'runtime.joint2d.inspect', ...['inspect', 'force', 'impulse'].map(action => `runtime.rigidbody2d.${action}`), ...['inspect', 'scroll', 'page', 'slider', 'toggle', 'text'].map(action => `runtime.control.${action}`), 'runtime.graphics.inspect',
    ...['state', 'play', 'pause', 'resume', 'stop', 'seek'].map(action => `runtime.animation.${action}`),
    ...['audio', 'video'].flatMap(type => ['state', 'play', 'pause', 'stop', 'seek'].map(action => `runtime.${type}.${action}`)),
    'runtime.webview.inspect', 'runtime.physics2d.inspect', 'runtime.physics2d.raycast', 'runtime.physics2d.test_point', 'runtime.physics2d.test_aabb', 'runtime.physics3d.inspect',
    'runtime.particle2d.state', 'runtime.particle2d.restart', 'runtime.particle2d.stop_emitting',
    'runtime.spine.inspect', 'runtime.spine.play', 'runtime.spine.set_skin', 'runtime.spine.set_attachment',
    'runtime.dragonbones.inspect', 'runtime.dragonbones.play',
    'runtime.ui.inspect', 'runtime.ui.assert', 'runtime.ui.hit_test', 'runtime.render2d.audit', 'runtime.label.audit', 'runtime.atlas.inspect',
  ];
  static readonly runtime = ['runtime.physics2d.contact_trace_start', 'runtime.spine.trace_start', 'runtime.dragonbones.trace_start', 'runtime.tween.plan', 'runtime.tween.start', 'runtime.collision2d.trace_start', 'runtime.task.poll', 'runtime.task.stop', 'runtime.collision2d.trace', ...this.features, 'runtime.tilemap.inspect', 'runtime.tilemap.query_region', 'runtime.tilemap.plan', 'runtime.tilemap.apply', 'runtime.shader.profile', 'runtime.asset.load', 'runtime.asset.preload', 'runtime.asset.inspect', 'runtime.asset.release', 'runtime.bundle.inspect', 'runtime.material.inspect', 'runtime.material.update', 'runtime.material.reset',
    'runtime.query', 'runtime.hierarchy', 'runtime.types', 'runtime.inspect', 'runtime.get', 'runtime.set', 'runtime.invoke',
    'runtime.create', 'runtime.release', 'runtime.subscribe', 'runtime.unsubscribe', 'runtime.events', 'runtime.pause', 'runtime.resume', 'runtime.capture', 'runtime.statistics',
  ];
}
