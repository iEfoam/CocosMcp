import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { AsarArchive } from './asar.js';

export interface SourceCapability {
  kind: 'message' | 'class' | 'method' | 'property' | 'function';
  name: string;
  owner: string;
  path: string;
  line: number;
  public: boolean;
  signature?: string;
  verification: 'source-only';
  context?: 'runtime' | 'editor' | 'shared';
  module?: string;
  platforms?: string[];
  conditions?: string[];
  internal?: boolean;
  deprecated?: boolean;
  sourceKind?: 'engine-source' | 'editor-source';
}

export interface EngineCapabilityManifest {
  sourceCommit?: string;
  rows: SourceCapability[];
  publicRows: number;
  internalRows: number;
  deprecatedRows: number;
  modules: Record<string, number>;
  conditions: Record<string, number>;
}

export class CatalogGenerator {
  async editor(archivePath: string): Promise<{ editorVersion: string; fingerprint: string; rows: SourceCapability[]; inspectedFiles: number }> {
    const archive = await AsarArchive.open(archivePath);
    const manifest = JSON.parse(await archive.read('package.json')) as { version: string };
    const paths = archive.list('builtin/').filter(path => /^builtin\/[^/]+\/package.json$/.test(path));
    const rows: SourceCapability[] = []; const hash = createHash('sha256');
    for (const path of paths) {
      const text = await archive.read(path); hash.update(path).update(text);
      const definition = JSON.parse(text) as { name: string; contributions?: { messages?: Record<string, { public?: boolean }> } };
      for (const [name, message] of Object.entries(definition.contributions?.messages ?? {})) {
        rows.push({ kind: 'message', name, owner: definition.name, path, line: 1, public: message.public === true, verification: 'source-only' });
      }
    }
    const declarations = archive.list('builtin/').filter(path => /\/@types\/(message|public)\.d\.ts$/.test(path));
    for (const path of declarations) {
      const text = await archive.read(path); hash.update(path).update(text);
      rows.push(...this.parse(path, text, 'editor-source'));
    }
    return { editorVersion: manifest.version, fingerprint: hash.digest('hex'), rows, inspectedFiles: paths.length + declarations.length };
  }

  async engine(root: string): Promise<{ fingerprint: string; rows: SourceCapability[]; inspectedFiles: number; excludedDirectories: string[]; features: unknown; manifest: EngineCapabilityManifest }> {
    const excluded = new Set(['node_modules', '.git', 'native', 'external', 'vendor', 'tests', 'test', '.codex-work']);
    const rows: SourceCapability[] = []; const hash = createHash('sha256'); let inspectedFiles = 0;
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(ts|js)$/.test(entry.name)) {
          const source = await readFile(path, 'utf8'); const rel = relative(root, path);
          hash.update(rel).update(source); rows.push(...this.parse(rel, source, 'engine-source')); inspectedFiles++;
        }
      }
    };
    const candidates = ['cocos', 'cocos2d', 'extensions', 'exports', 'pal', 'platforms'];
    for (const directory of candidates) {
      const path = join(root, directory);
      if (await stat(path).then(value => value.isDirectory(), () => false)) await walk(path);
    }
    const config = await readFile(join(root, 'cc.config.json'), 'utf8').catch(() => '{}');
    hash.update('cc.config.json').update(config);
    const manifest = this.manifest(rows);
    return { fingerprint: hash.digest('hex'), rows, inspectedFiles, excludedDirectories: [...excluded], features: (JSON.parse(config) as { features?: unknown }).features ?? {}, manifest };
  }

  parse(path: string, source: string, sourceKind: SourceCapability['sourceKind'] = 'engine-source'): SourceCapability[] {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const rows: SourceCapability[] = [];
    const add = (node: ts.Node, kind: SourceCapability['kind'], name: string, owner: string, isPublic: boolean): void => {
      const text = node.getFullText(file);
      const tags = ts.getJSDocTags(node).map(tag => tag.tagName.text);
      // 引擎内部类的成员即使声明 public，也不能被能力挖掘器当成稳定公共 API。
      const inheritedTags = node.parent && (ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent))
        ? ts.getJSDocTags(node.parent).map(tag => tag.tagName.text) : [];
      const internal = [...tags, ...inheritedTags].some(tag => ['internal', 'engineInternal', 'mangle'].includes(tag)) || name.startsWith('_');
      const scopes: string[] = []; let scope: ts.Node | undefined = node;
      while (scope && !ts.isSourceFile(scope)) { scopes.push(scope.getText(file)); scope = scope.parent; }
      const conditions = [...new Set([...scopes.join('\n').matchAll(/\b(EDITOR|PREVIEW|NATIVE|HTML5|WEBGL|WEBGPU|JSB|MINIGAME|XR)\b/g)].map(match => match[1]!))];
      const platforms = [...new Set([
        ...(conditions.some(condition => ['NATIVE', 'JSB'].includes(condition)) ? ['native'] : []),
        ...(conditions.some(condition => ['HTML5', 'WEBGL', 'WEBGPU', 'MINIGAME'].includes(condition)) ? ['web'] : []),
      ])];
      if (!platforms.length) platforms.push('all');
      const module = path.replace(/^.*?(?:cocos|extensions)[/\\]/, '').split(/[/\\]/)[0] || 'root';
      const row: SourceCapability = { kind, name, owner, path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        public: isPublic && !internal, verification: 'source-only', context: sourceKind === 'editor-source' ? 'editor' : 'runtime', module,
        platforms, conditions, internal, deprecated: tags.includes('deprecated') || /@deprecated/.test(text), sourceKind };
      if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isFunctionDeclaration(node)) {
        row.signature = `(${node.parameters.map(parameter => parameter.getText(file)).join(', ')})${node.type ? ': ' + node.type.getText(file) : ''}`;
      }
      rows.push(row);
    };
    const visit = (node: ts.Node, owner = ''): void => {
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        const name = node.name?.text ?? 'anonymous'; add(node, 'class', name, owner, !name.startsWith('_'));
        for (const member of node.members) {
          const name = member.name?.getText(file).replace(/^['"]|['"]$/g, ''); if (!name) continue;
          const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
          const isPublic = !name.startsWith('_') && !modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
          add(member, ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ? 'method' : 'property', name, node.name?.text ?? owner, isPublic);
        }
      } else if (ts.isFunctionDeclaration(node) && node.name) add(node, 'function', node.name.text, owner, !node.name.text.startsWith('_'));
      // 2.x 的 cc.Class 使用对象字面量声明类型，保留其成员作为候选，不能据此宣称可运行。
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'cc.Class') {
        const argument = node.arguments[0];
        if (argument && ts.isObjectLiteralExpression(argument)) {
          const nameProperty = argument.properties.find(property => property.name?.getText(file) === 'name');
          const className = nameProperty && ts.isPropertyAssignment(nameProperty) ? nameProperty.initializer.getText(file).replace(/^['"]|['"]$/g, '') : path;
          add(node, 'class', className, owner, true);
          for (const property of argument.properties) {
            const name = property.name?.getText(file); if (name) add(property, ts.isMethodDeclaration(property) ? 'method' : 'property', name, className, !name.startsWith('_'));
          }
        }
      }
      ts.forEachChild(node, child => visit(child, owner));
    };
    visit(file); return rows;
  }

  private manifest(rows: SourceCapability[]): EngineCapabilityManifest {
    const modules: Record<string, number> = {}; const conditions: Record<string, number> = {};
    for (const row of rows) {
      if (row.module) modules[row.module] = (modules[row.module] ?? 0) + 1;
      for (const condition of row.conditions ?? []) conditions[condition] = (conditions[condition] ?? 0) + 1;
    }
    return { rows, publicRows: rows.filter(row => row.public && !row.internal).length,
      internalRows: rows.filter(row => row.internal).length, deprecatedRows: rows.filter(row => row.deprecated).length, modules, conditions };
  }
}
