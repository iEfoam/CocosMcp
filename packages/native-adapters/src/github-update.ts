import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectPaths } from '../../application/src/paths.js';
import { ExtensionInstaller } from './installer.js';
import files from './extension-files.json' with { type: 'json' };

export const RELEASE_API = 'https://api.github.com/repos/iEfoam/CocosMcp/releases/latest';
export interface ReleaseVersion { version: string; buildId: string; url: string; digest: string }
interface Bundle { version: string; buildId: string; major: number; rows: Array<{path: string; content: string}> }

export class GithubUpdate {
  constructor(private readonly request: typeof fetch = fetch) {}
  private async download(url: string, limit: number): Promise<Buffer> {
    const response = await this.request(url, {headers: {'User-Agent': 'CocosMCP', Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(response.status === 404 ? 'GitHub 尚未发布可安装版本，请等待自动构建完成' : `GitHub 请求失败 (${response.status})`);
    if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('更新文件超过大小限制');
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of response.body!) { length += chunk.length; if (length > limit) throw new Error('更新文件超过大小限制'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async latest(major: 2 | 3): Promise<ReleaseVersion> {
    const release = JSON.parse((await this.download(RELEASE_API, 1024 * 1024)).toString()) as {tag_name: string; prerelease?: boolean; draft?: boolean; assets: Array<{name: string; browser_download_url: string; digest: string}>};
    if (release.prerelease || release.draft) throw new Error('Stable updater refuses development or draft releases');
    const asset = release.assets.find(row => row.name === `cocos-mcp-creator${major}.full.json`)
      ?? release.assets.find(row => row.name === `cocos-mcp-creator${major}.json`);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('GitHub 发布缺少对应扩展包或 SHA-256 校验值');
    const url = new URL(asset.browser_download_url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/iEfoam/CocosMcp/releases/download/')) throw new Error('更新包不属于 iEfoam/CocosMcp');
    return {version: release.tag_name.replace(/^v/, ''), buildId: release.tag_name, url: url.href, digest: asset.digest.slice(7)};
  }
  validate(data: Buffer, release: ReleaseVersion, major: 2 | 3): Bundle {
    if (createHash('sha256').update(data).digest('hex') !== release.digest) throw new Error('更新包 SHA-256 校验失败');
    const bundle = JSON.parse(data.toString()) as Bundle;
    const required = files[major], allowed = [...required, ...files.presentation];
    if (bundle.major !== major || bundle.version !== release.version || bundle.buildId !== release.buildId || !Array.isArray(bundle.rows)
      || ![required.length, allowed.length].includes(bundle.rows.length)
      || (release.url.endsWith('.full.json') && bundle.rows.length !== allowed.length)) throw new Error('更新包版本或结构不匹配');
    const seen = new Set<string>();
    for (const row of bundle.rows) {
      if (!allowed.includes(row.path) || seen.has(row.path) || typeof row.content !== 'string') throw new Error('更新包包含非法或重复路径');
      seen.add(row.path);
    }
    // 旧包必须保留所有运行文件，新包必须同时带齐展示资料，不能用文档替换必需入口。
    if (required.some(path => !seen.has(path)) || (bundle.rows.length === allowed.length && allowed.some(path => !seen.has(path)))) throw new Error('更新包版本或结构不匹配');
    const manifest = JSON.parse(Buffer.from(bundle.rows.find(row => row.path === 'package.json')!.content, 'base64').toString());
    if (manifest.name !== `cocos-mcp-creator${major}` || manifest.version !== bundle.version || manifest.buildId !== bundle.buildId) throw new Error('扩展身份校验失败');
    return bundle;
  }
  async install(project: string, major: 2 | 3): Promise<ReleaseVersion> {
    const release = await this.latest(major);
    const paths = await ProjectPaths.open(project);
    const target = await paths.resolve(`${major === 2 ? 'packages' : 'extensions'}/cocos-mcp-creator${major}`);
    const installed = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    if (installed.version === release.version && installed.buildId === release.buildId) {
      const complete = await Promise.all(files.presentation.map(path => stat(join(target, path)).then(value => value.isFile(), error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      })));
      // 旧更新器第一次升级只能安装运行文件；新版更新器允许同版本补齐缺失资料。
      if (!release.url.endsWith('.full.json') || complete.every(Boolean)) return release;
    }
    const data = await this.download(release.url, 40 * 1024 * 1024);
    const bundle = this.validate(data, release, major);
    const stagingName = `github-${randomUUID()}`;
    const buildRoot = await paths.work('downloads', stagingName);
    // 包只包含固定文件清单，避免归档解压的路径穿越和符号链接逃逸。
    for (const row of bundle.rows) {
      const directory = row.path.startsWith('dist/') ? `extensions/creator${major}/dist` : `extensions/creator${major}`;
      const folder = await paths.work('downloads', `${stagingName}/${directory}`);
      await writeFile(join(folder, row.path.split('/').pop()!), Buffer.from(row.content, 'base64'));
    }
    await new ExtensionInstaller().install(project, major, buildRoot);
    return release;
  }
}
