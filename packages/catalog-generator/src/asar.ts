import { open, readFile } from 'node:fs/promises';
import { join, normalize, isAbsolute } from 'node:path';
import { CocosError } from '../../contracts/src/index.js';

interface AsarEntry { files?: Record<string, AsarEntry>; offset?: string; size?: number; unpacked?: boolean; link?: string }

export class AsarArchive {
  private constructor(readonly path: string, private readonly header: AsarEntry, private readonly dataOffset: number) {}

  static async open(path: string): Promise<AsarArchive> {
    const file = await open(path, 'r');
    try {
      const prefix = Buffer.alloc(16); await file.read(prefix, 0, 16, 0);
      const size = prefix.readUInt32LE(12); const headerSize = prefix.readUInt32LE(4);
      if (size > 64 * 1024 * 1024 || size > headerSize) throw new CocosError('INVALID_ARGUMENT', 'Invalid ASAR header');
      const bytes = Buffer.alloc(size); await file.read(bytes, 0, size, 16);
      return new AsarArchive(path, JSON.parse(bytes.toString('utf8')) as AsarEntry, 8 + headerSize);
    } finally { await file.close(); }
  }

  list(prefix = ''): string[] {
    const rows: string[] = [];
    const walk = (entry: AsarEntry, path: string): void => {
      for (const [name, child] of Object.entries(entry.files ?? {})) {
        const full = path ? `${path}/${name}` : name;
        if (child.files) walk(child, full); else if (full.startsWith(prefix)) rows.push(full);
      }
    };
    walk(this.header, ''); return rows;
  }

  async read(path: string): Promise<string> {
    if (isAbsolute(path) || normalize(path).startsWith('..') || path.includes('\\')) throw new CocosError('INVALID_ARGUMENT', 'Invalid archive path');
    let entry = this.header;
    for (const segment of path.split('/')) {
      const child = entry.files?.[segment];
      if (!child) throw new CocosError('NOT_FOUND', `Archive file not found: ${path}`);
      entry = child;
    }
    if (entry.link) throw new CocosError('UNSUPPORTED_CAPABILITY', 'Archive links are not followed');
    if (entry.unpacked) return readFile(join(`${this.path}.unpacked`, path), 'utf8');
    if (entry.size === undefined || entry.offset === undefined) throw new CocosError('INVALID_ARGUMENT', 'Not a regular archive file');
    if (entry.size > 64 * 1024 * 1024) throw new CocosError('INVALID_ARGUMENT', 'Archive file exceeds inspection limit');
    const file = await open(this.path, 'r');
    try { const bytes = Buffer.alloc(entry.size); await file.read(bytes, 0, bytes.length, this.dataOffset + Number(entry.offset)); return bytes.toString('utf8'); }
    finally { await file.close(); }
  }
}
