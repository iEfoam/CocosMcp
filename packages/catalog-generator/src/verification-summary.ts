import { CapabilityCatalog } from '../../capability-catalog/src/index.js';
import { Json, type JsonObject } from '../../contracts/src/index.js';

/** 摘要与运行包共享目录和证据注册表，不从操作数量推断原生或模块验收完成。 */
export class VerificationSummary {
  constructor(private readonly catalog = new CapabilityCatalog()) {}
  create(sourceFingerprint: string, tests: JsonObject): { json: JsonObject; markdown: string } {
    const capabilities = this.catalog.search('', undefined, 0, 10000).rows;
    const coverage = this.catalog.coverage();
    const nativeLevels = ['editor-verified', 'runtime-verified', 'device-verified'];
    const versions = [2, 3].map(major => {
      const supported = capabilities.filter(row => row.supportedMajors?.includes(major as 2 | 3));
      const native = supported.filter(row => row.verificationEvidence?.some(record => record.applicability === 'current-source' && nativeLevels.includes(record.level) && record.creatorVersion?.startsWith(`${major}.`)));
      return { major, supportedOperations: supported.length, currentNativeOperations: native.length,
        creatorVersions: [...new Set(native.flatMap(row => row.verificationEvidence!.filter(record => record.applicability === 'current-source' && nativeLevels.includes(record.level) && record.creatorVersion?.startsWith(`${major}.`)).map(record => record.creatorVersion!)))],
        unverifiedOperationIds: supported.filter(row => !native.includes(row)).map(row => row.id) };
    });
    const json: JsonObject = { schemaVersion: 1, sourceFingerprint, generatedAt: new Date().toISOString(), tests,
      counting: Json.value(coverage.counting), versions: Json.value(versions),
      rows: Json.value(coverage.rows.map(row => ({ moduleId: row.id, title: row.title, registeredOperations: row.registeredOperations,
        implementedOperations: row.implementedOperations, testedEntries: row.testedEntries, verifiedOperations: row.verifiedOperations,
        status: row.status, scopeAcceptance: row.scopeAcceptance, verification: row.verification }))),
      limitations: ['注册、实现、适配器测试、原生验收和模块范围验收分别统计，不能互相替代', '历史证据不提升当前源码等级', '保存重开、实际点击和设备验收需要独立的当前源码证据'] };
    const lines = ['# 当前构建验证摘要', '', `源码指纹：\`${sourceFingerprint}\``, '',
      `全量测试状态：**${String(tests.state)}**。${String(tests.reason ?? '')}`, '',
      `测试计数：\`${JSON.stringify(tests.counts ?? null)}\``, '',
      `报告 SHA-256：\`${String(tests.reportSha256 ?? 'unknown')}\``, '',
      `环境：\`${JSON.stringify(tests.environment ?? null)}\``, '',
      '| Creator 主版本 | 适用操作 | 当前版本原生证据覆盖操作 | 已记录原生版本 |', '| --- | ---: | ---: | --- |',
      ...versions.map(row => `| ${row.major} | ${row.supportedOperations} | ${row.currentNativeOperations} | ${row.creatorVersions.join(', ') || 'unknown'} |`), '',
      '| 模块 | 注册 | 实现 | 有测试证据入口 | 原生证据操作 | 范围验收 |', '| --- | ---: | ---: | ---: | ---: | --- |',
      ...coverage.rows.map(row => `| ${row.id} | ${row.registeredOperations} | ${row.implementedOperations} | ${row.testedEntries} | ${row.verifiedOperations} | ${row.scopeAcceptance} |`), '',
      '完整缺口列表见同名 JSON 的 versions[].unverifiedOperationIds。适配器测试使用测试桩；原生范围缺少当前源码证据时维持 unknown/pending，不能由历史快照或注册数量推断通过。', ''];
    return { json, markdown: lines.join('\n') };
  }
}
