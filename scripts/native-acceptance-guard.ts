import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CocosError, type JsonObject } from '../packages/contracts/src/index.js';
import type { CreatorInstance, ExistingCreator } from './creator-account.mjs';

/** 原生验收只能操作明确指定的隔离工程；桥接认证不代表账号已登录。 */
export class NativeAcceptanceGuard {
  constructor(private readonly repositoryRoot: string) {}
  async project(project: string, major: 2 | 3): Promise<string> {
    const root = await realpath(this.repositoryRoot);
    const expected = resolve(root, major === 3 ? '../CocosMcp-UI-Test-3.8.8' : '.codex-work/build/creator2-test-project');
    const actual = await realpath(project);
    if (actual !== await realpath(expected)) throw new CocosError('UNAUTHORIZED', 'Native acceptance requires the exact designated isolated project');
    return actual;
  }
  editor(editor: ExistingCreator | null, major: 2 | 3): CreatorInstance {
    if (editor?.status !== 'existing-editor-reused' || editor.creatorMajor !== major || editor.loginState !== 'logged-in') {
      throw new CocosError('UNAUTHORIZED', 'Native acceptance requires a verified matching editor and confirmed login', {
        status: editor?.status ?? 'absent', loginState: editor?.loginState ?? 'unknown',
      });
    }
    return editor;
  }
  preview(preview: JsonObject): void {
    // 历史会话 ID 不是本轮所有权证明；不停止用户或其他任务正在使用的预览。
    if (preview.running !== false) throw new CocosError('RESOURCE_BUSY', 'Existing or unknown preview state must be preserved before native acceptance');
  }
}
