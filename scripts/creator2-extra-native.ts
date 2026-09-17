import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CocosApplication, ProjectRegistry } from '../packages/application/src/index.js';
import { RuntimeGateway } from '../packages/application/src/runtime-gateway.js';
import { CocosError, Json, type JsonObject } from '../packages/contracts/src/index.js';

class Creator2ExtendedAcceptance {
  async run(): Promise<void> {
    const project = resolve('.codex-work/build/creator2-test-project'), output = resolve('.codex-work/logs/creator2-native');
    const registry = new ProjectRegistry(), { projectId } = await registry.add(project), gateway = new RuntimeGateway(registry), gatewayPort = await gateway.start();
    const app = new CocosApplication(registry, undefined, undefined, true, gateway), rows: JsonObject[] = []; let preview = false;
    const record = async (): Promise<void> => { await mkdir(output, { recursive: true }); await writeFile(join(output, 'extended-report.json'), JSON.stringify({ project, rows }, null, 2)); };
    const call = async (id: string, params: JsonObject = {}): Promise<JsonObject> => {
      try { const result = Json.object((await app.execute({ projectId, capabilityId: id, params })).result); rows.push({ id, result, passed: true }); console.log(`PASS ${id}`); await record(); return result; }
      catch (error) { rows.push({ id, passed: false, error: CocosError.from(error).toJSON() as unknown as JsonObject }); await record(); throw error; }
    };
    const suite = async (name: string, operation: () => Promise<void>): Promise<void> => {
      try { await operation(); rows.push({ suite: name, passed: true }); }
      catch (error) { rows.push({ suite: name, passed: false, message: CocosError.from(error).message }); console.error(`FAIL ${name}: ${CocosError.from(error).message}`); process.exitCode = 1; }
      await record();
    };
    try {
      const sceneId = Json.object((await call('scene.query')).scene).sceneId!; const suffix = String(Date.now());
      const previous = (await call('scene.hierarchy')).rows as JsonObject[];
      for (const node of previous) if (/^ExtraCoverage-\d+$/.test(String(node.name))) await call('node.set', { nodeId: node.nodeId!, properties: { active: false } });
      const root = (await call('node.create', { parentId: sceneId, name: `ExtraCoverage-${suffix}` })).nodeId!;
      await suite('editor-basics', async () => {
        await call('editor.environment'); await call('component.types'); await call('view.query'); await call('project.settings.get', { name: 'project' });
        await call('selection.set', { type: 'node', ids: [root] }); assert.ok((await call('selection.query', { type: 'node' })).rows);
        const baseline = (await call('scene.snapshot')).snapshot!; assert.equal((await call('scene.diff', { baseline })).equal, true);
        const child = (await call('node.create', { parentId: root, name: 'MoveProbe' })).nodeId!;
        await call('node.set', { nodeId: child, properties: { x: 24, y: 40, scaleX: 2, scaleY: 2 } });
        await call('node.reparent', { nodeId: child, parentId: sceneId, keepWorldTransform: true });
        await call('node.reset', { nodeId: child }); const duplicate = (await call('node.duplicate', { nodeId: child })).nodeId!;
        const componentId = (await call('component.add', { nodeId: duplicate, type: 'cc.Label' })).componentId!;
        await call('component.query', { componentId }); await call('component.delete', { componentId }); await call('node.delete', { nodeId: duplicate }); await call('node.delete', { nodeId: child });
      });
      await suite('asset-roundtrip', async () => {
        const location = await call('asset.location', { url: `db://assets/CoverageData${suffix}.json` });
        await call('asset.create', { url: location.url!, content: '{"coverage":1}' }); await call('asset.info', { url: location.url! }); await call('asset.meta', { url: location.url! });
        await call('asset.save', { url: location.url!, content: '{"coverage":2}' }); await call('asset.refresh', { url: location.url! }); await call('asset.reimport', { url: location.url! });
        const copyLocation = await call('asset.location', { url: `db://assets/CoverageDataCopy${suffix}.json` }); await call('asset.copy', { sourceUrl: location.url!, targetUrl: copyLocation.url! });
        const moved = String(copyLocation.url).replace('Copy','Moved'); const before = await call('asset.resolve', { reference: copyLocation.url! });
        await call('asset.move', { sourceUrl: copyLocation.url!, targetUrl: moved }); assert.equal((await call('asset.resolve', { reference: moved })).uuid, before.uuid);
        await call('asset.users', { url: location.url! }); await call('asset.delete', { url: moved });
        const plan = await call('asset.organize.plan'); await call('asset.organize.apply', { planHash: plan.planHash! });
      });
      await suite('prefab-roundtrip', async () => {
        const node = (await call('node.create', { parentId: root, name: 'PrefabProbe' })).nodeId!;
        const location = await call('asset.location', { url: `db://assets/CoveragePrefab${suffix}.prefab` });
        await call('prefab.create', { nodeId: node, url: location.url! }); const uuid = (await call('asset.resolve', { reference: location.url! })).uuid!;
        const instance = (await call('prefab.instantiate', { parentId: root, uuid })).nodeId!;
        await call('node.set', { nodeId: instance, properties: { width: 180 } }); await call('prefab.apply', { nodeId: instance });
        await call('node.set', { nodeId: instance, properties: { width: 90 } }); await call('prefab.revert', { nodeId: instance });
        assert.equal(Json.object(Json.object((await call('node.query', { nodeId: instance })).node).size).width, 180, 'Prefab revert must restore applied width');
        await call('prefab.unlink', { nodeId: instance }); assert.equal(Json.object((await call('node.query', { nodeId: instance })).node).prefab, null);
      });
      await suite('shader-material', async () => {
        await call('shader.environment');
        const location = await call('asset.location', { url: `db://assets/Creator2Shader${suffix}.effect` });
        const content = await readFile('/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/Resources/static/default-assets/resources/effects/builtin-2d-sprite.effect', 'utf8');
        const created = await call('shader.create', { url: location.url!, content }); await call('shader.inspect', { url: location.url! });
        const changed = await call('shader.update', { url: location.url!, expectedHash: created.sourceHash!, content: `${content}\n// Native coverage edit\n` });
        await call('shader.restore', { backupId: changed.backupId!, expectedHash: changed.sourceHash! });
        const materialLocation = await call('asset.location', { url: `db://assets/Creator2Material${suffix}.mtl` });
        await call('material.create', { url: materialLocation.url!, effectUrl: location.url!, properties: { alphaThreshold: 0.25 } });
        const materialSource = await call('material.query', { url: materialLocation.url! });
        const materialEdit = await call('material.update', { url: materialLocation.url!, expectedHash: materialSource.sourceHash!, properties: { alphaThreshold: 0.35 } });
        await call('material.bindings', { url: materialLocation.url! });
        await call('shader.restore', { backupId: materialEdit.backupId!, expectedHash: materialEdit.sourceHash! }); await call('material.properties', { url: materialLocation.url! }); await call('material.defines', { url: materialLocation.url! }); await call('material.states', { url: materialLocation.url! });
        const copyLocation = await call('asset.location', { url: `db://assets/Creator2MaterialCopy${suffix}.mtl` }); await call('material.clone', { sourceUrl: materialLocation.url!, targetUrl: copyLocation.url! });
      });
      await suite('media-fixtures', async () => {
        const base = '/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/Resources/templates/example-cases/assets';
        const downloads = join(project, '.codex-work/downloads/media'); await mkdir(downloads, { recursive: true });
        for (const [file, path, type] of [['ding.mp3', 'resources/audio/ding.mp3', 'cc.AudioSource'], ['cocosvideo.mp4', 'res/cocosvideo.mp4', 'cc.VideoPlayer']]) {
          const location = await call('asset.location', { url: `db://assets/${file}` });
          if (!location.targetExists) { const sourcePath = join(downloads, file!); await copyFile(join(base, path!), sourcePath); await call('asset.import', { sourcePath, targetUrl: location.url! }); }
          const uuid = (await call('asset.resolve', { reference: location.url! })).uuid!;
          const nodeId = (await call('node.create', { parentId: root, name: `${type}Probe` })).nodeId!;
          const componentId = (await call('component.add', { nodeId, type: type! })).componentId!;
          await call('component.set', { componentId, properties: { clip: { uuid }, volume: 0, ...(type === 'cc.VideoPlayer' ? { resourceType: 1, mute: true } : { playOnLoad: false }) } });
        }
      });
      const skeletons: Array<{ name: string; nodeId: string }> = [];
      await suite('skeleton-import', async () => {
        const base = '/Applications/Cocos/Creator/2.4.15/CocosCreator.app/Contents/Resources/templates/example-cases/assets/resources';
        const textureFolder = String((await call('asset.location', { url: 'db://assets/Creator2SkeletonProbe.png' })).folderUrl);
        const fixture = async (family: string, files: string[], source: string): Promise<Map<string,string>> => {
          const uuids = new Map<string,string>();
          const downloads = join(project,'.codex-work/downloads',family); await mkdir(downloads,{recursive:true});
          for (const file of files) {
            const location = await call('asset.location', { url: `${textureFolder}/Creator2SkeletonFixtures/${family}/${file}` });
            if (!location.targetExists) { const sourcePath=join(downloads,file);await copyFile(join(base,source,file),sourcePath);await call('asset.import',{sourcePath,targetUrl:location.url!}); }
            uuids.set(file,String((await call('asset.resolve',{reference:location.url!})).uuid));
          }
          return uuids;
        };
        const spine = await fixture('Spine',['raptor.png','raptor.atlas','raptor.json'],'spineRaptor');
        const spineNode = (await call('node.create',{parentId:root,name:'SpineProbe'})).nodeId!;
        const spineId = (await call('component.add',{nodeId:spineNode,type:'sp.Skeleton'})).componentId!;
        await call('component.set',{componentId:spineId,properties:{skeletonData:{uuid:spine.get('raptor.json')!},timeScale:0}}); skeletons.push({name:'spine',nodeId:String(spineNode)});
        const dragon = await fixture('DragonBones',['texture.png','texture.json','NewDragonTest.json'],'dragonBones');
        const dragonData = JSON.parse(await readFile(join(base,'dragonBones/NewDragonTest.json'),'utf8'));
        const dragonNode = (await call('node.create',{parentId:root,name:'DragonBonesProbe'})).nodeId!;
        const dragonId = (await call('component.add',{nodeId:dragonNode,type:'dragonBones.ArmatureDisplay'})).componentId!;
        await call('component.set',{componentId:dragonId,properties:{dragonAsset:{uuid:dragon.get('NewDragonTest.json')!},dragonAtlasAsset:{uuid:dragon.get('texture.json')!},armatureName:dragonData.armature[0].name,timeScale:0}}); skeletons.push({name:'dragonbones',nodeId:String(dragonNode)});
      });
      let physicsNode: string | undefined;
      await suite('physics-fixture',async()=>{ const nodeId=(await call('node.create',{parentId:root,name:'PhysicsProbe'})).nodeId!;physicsNode=String(nodeId);await call('node.set',{nodeId,properties:{active:false}});const body=(await call('component.add',{nodeId,type:'cc.RigidBody'})).componentId!;await call('component.set',{componentId:body,properties:{type:2,gravityScale:0}});const collider=(await call('component.add',{nodeId,type:'cc.PhysicsBoxCollider'})).componentId!;await call('component.set',{componentId:collider,properties:{size:{width:100,height:100}}}); });
      await suite('particle-fixture',async()=>{const node=(await call('node.create',{parentId:root,name:'ParticleProbe'})).nodeId!;await call('component.add',{nodeId:node,type:'cc.ParticleSystem'});});
      await call('scene.save');
      await suite('runtime-features', async () => {
        await call('preview.start',{width:800,height:600,visible:true});preview=true;await call('shader.preview.connect',{gatewayPort});
        const hierarchy = (await call('runtime.hierarchy',{limit:1000})).rows as JsonObject[];
        for(const skeleton of skeletons){const node=hierarchy.find(row=>row.nodeId===skeleton.nodeId)!;const c=(node.components as JsonObject[]).find(c=>c.type===(skeleton.name==='spine'?'sp.Skeleton':'dragonBones.ArmatureDisplay'))!;
          const data=await call(`runtime.${skeleton.name}.inspect`,{componentId:c.componentId!});assert.ok((data.animations as unknown[]).length);await call(`runtime.${skeleton.name}.play`,{componentId:c.componentId!,name:(data.animations as string[])[0]!});
          if(skeleton.name==='spine'&&(data.skins as string[]).length)await call('runtime.spine.set_skin',{componentId:c.componentId!,name:(data.skins as string[])[0]!});
        }
        const particle = hierarchy.flatMap(row=>row.components as JsonObject[]).find(c=>c.type==='cc.ParticleSystem');if(particle)for(const action of ['state','restart','stop_emitting'])await call(`runtime.particle2d.${action}`,{componentId:particle.componentId!});
        for (const family of ['audio', 'video']) {
          const component = hierarchy.flatMap(row=>row.components as JsonObject[]).find(c=>c.type===(family==='audio'?'cc.AudioSource':'cc.VideoPlayer'));
          if (component) { const params = { componentId: component.componentId! }; await call(`runtime.${family}.state`, params); await call(`runtime.${family}.play`, params); await call(`runtime.${family}.pause`, params); await call(`runtime.${family}.seek`, { ...params, time: 0 }); await call(`runtime.${family}.stop`, params); }
        }
        const sprite = hierarchy.flatMap(row=>row.components as JsonObject[]).find(c=>c.type==='cc.Sprite');
        if(sprite){await call('runtime.material.inspect',{componentId:sprite.componentId!});await call('runtime.material.update',{componentId:sprite.componentId!,properties:{alphaThreshold:0.2}});await call('runtime.material.update',{componentId:sprite.componentId!,properties:{alphaThreshold:0.3}});await call('runtime.material.reset',{componentId:sprite.componentId!});}
        await call('runtime.physics3d.inspect'); await call('runtime.statistics'); await call('runtime.graphics.inspect'); await call('runtime.shader.profile',{frames:5,warmupFrames:1});
        const physicsHandle=Json.object((await call('runtime.invoke',{target:'cc.director',method:'getPhysicsManager'})).value).handle!;
        await call('runtime.set',{target:physicsHandle,path:'enabled',value:true});
        // 2.x 刚体必须在物理世界启用后进入 onEnable，避免引擎生成没有原生 body 的半初始化状态。
        assert.ok(physicsNode);await call('runtime.set',{target:`node:${physicsNode}`,path:'active',value:true});
        await call('runtime.shader.profile',{frames:2,warmupFrames:1});
        const previewLogs = await call('preview.logs'); assert.ok(!previewLogs.persistenceError, 'Preview logs must persist on Creator 2 bundled Node');
        assert.ok(!(previewLogs.rows as JsonObject[]).some(row => String(row.message).includes('is not defined in the Scene')), 'Scene inspection must avoid unsupported Node getters');
        await call('runtime.get',{target:`node:${physicsNode}`,path:'activeInHierarchy'});
        const physicsRow = hierarchy.find(row => row.nodeId === physicsNode)!;
        const colliderRow = (physicsRow.components as JsonObject[]).find(row => row.type === 'cc.PhysicsBoxCollider')!;
        await call('runtime.get',{target:`component:${colliderRow.componentId}`,path:'body'});
        await call('runtime.invoke',{target:`component:${colliderRow.componentId}`,method:'getAABB'});
        for (const [id, params] of [
          ['runtime.physics2d.test_point', {point:{x:0,y:0}}],
          ['runtime.physics2d.test_aabb', {x:-50,y:-50,width:100,height:100}],
          ['runtime.physics2d.raycast', {start:{x:-200,y:0},end:{x:200,y:0}}],
        ] as Array<[string, JsonObject]>) {
          const hits = await call(id, params);
          assert.ok((hits.rows as JsonObject[]).some(hit => hit.nodeId === physicsNode), `${id} must hit the owned fixture`);
        }
        await call('preview.stop');preview=false;
      });
    } finally { try { if(preview)await call('preview.stop'); } finally {await record();await gateway.close();} }
  }
}
await new Creator2ExtendedAcceptance().run();
