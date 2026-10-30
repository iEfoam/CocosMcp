import { CocosError } from '../../../packages/contracts/src/index.js';
import { RuntimeAccess as A, type RuntimeObject } from '../../../packages/runtime3-bridge/src/access.js';
import type { SceneInspector } from '../../../packages/runtime3-bridge/src/scene.js';

/** 3.8.8 SceneUndoCommand 原生记录适配；不拼装场景文件，不替换原生撤销算法。 */
export class Creator3StructureUndo {
  private readonly manager: RuntimeObject;
  private readonly command: RuntimeObject;
  private readonly initialIds: Set<string>;
  private readonly previous: unknown[];
  private readonly index: number;
  private readonly commandId: string;
  private ended = false;

  constructor(private readonly inspector: SceneInspector, private readonly facade: RuntimeObject, private readonly rootId: string) {
    this.manager = A.object(A.object(A.call(facade, 'getCurrentFacade'))._undoMgr, 'native undo manager');
    const { _manualCommands: manual, _autoCommands: automatic, _commandArray: history, _index: index } = this.manager;
    if (!Array.isArray(manual) || !Array.isArray(automatic) || !Array.isArray(history) || !Number.isInteger(index)) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native undo manager does not match the 3.8.8 adapter');
    if (manual.length || automatic.length) throw new CocosError('RESOURCE_BUSY', 'Another native undo recording is in progress');
    this.index = Number(index); this.previous = history.slice(0, this.index + 1);
    this.initialIds = new Set(this.identities());
    this.commandId = String(A.call(facade, 'beginRecording', [...this.initialIds], { auto: false, tag: 'CocosMCP structure' }));
    const command = manual.find(row => A.object(row).id === this.commandId);
    if (!command || !(A.object(command).undoData instanceof Map) || !Array.isArray(A.object(command).uuids) || A.object(command).auto !== false) {
      A.call(facade, 'cancelRecording', this.commandId);
      throw new CocosError('UNSUPPORTED_CAPABILITY', 'Native manual undo command is unavailable');
    }
    this.command = A.object(command);
  }

  finish(): void {
    if (this.ended) throw new CocosError('OPERATION_CONFLICT', 'Native undo checkpoint was already submitted');
    this.ended = true;
    // 新 UUID 只有原生创建后才能取得；其批次开始时的状态必然不存在。其他对象沿用原生 beginRecording 的完整 dump。
    for (const uuid of this.identities()) if (!this.initialIds.has(uuid)) {
      (this.command.uuids as string[]).push(uuid);
      (this.command.undoData as Map<string, unknown>).set(uuid, null);
    }
    if (A.call(this.facade, 'endRecording', this.commandId) !== true) throw new CocosError('VERIFICATION_FAILED', 'Native manual undo recording did not finish');
    const history = this.manager._commandArray as unknown[];
    if (this.manager._index !== this.index + 1 || history[this.index + 1] !== this.command || this.previous.some((entry, index) => history[index] !== entry)) {
      throw new CocosError('VERIFICATION_FAILED', 'Other native undo commands interleaved with the structure batch');
    }
  }

  private identities(): string[] {
    return this.inspector.all(this.inspector.node(this.rootId)).flatMap(node => [A.uuid(node), ...(node._components as RuntimeObject[]).map(A.uuid)]);
  }
}
