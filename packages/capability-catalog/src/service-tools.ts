import type { Verification } from '../../contracts/src/index.js';

export interface ServiceTool {
  id: string; module: string; title: string; implementation: 'implemented'; verification: Verification;
  prerequisite?: 'build-service' | 'runtime-gateway'; delegatesTo?: string;
}

/** 独立服务入口必须参与清单；已有能力的别名不重复计入模块操作数。 */
export class ServiceTools {
  list(): ServiceTool[] {
    const rows: Array<[string, string, string, ServiceTool['prerequisite']?, string?]> = [
      ['cocos_projects', 'F01', '工程列表'], ['cocos_instances', 'F01', '编辑器实例'],
      ['cocos_capability_search', 'F54', '能力搜索'], ['cocos_capability_describe', 'F54', '能力详情'], ['cocos_coverage', 'F54', '覆盖清单'],
      ['cocos_capability_execute', 'F54', '通用能力分发', undefined, '*'],
      ['cocos_assets_organize_plan', 'F13', '资源整理预览', undefined, 'asset.organize.plan'],
      ['cocos_assets_organize_apply', 'F13', '资源整理执行', undefined, 'asset.organize.apply'],
      ['cocos_workflow_plan', 'F52', '工作流规划'], ['cocos_workflow_execute', 'F52', '工作流执行'], ['cocos_workflow_status', 'F52', '工作流状态'],
      ['cocos_operation_query', 'F10', '操作结果查询'], ['cocos_runtime_instances', 'F39', '运行时实例', 'runtime-gateway'],
      ['cocos_build_start', 'F47', '启动构建', 'build-service'], ['cocos_build_status', 'F47', '构建状态', 'build-service'],
      ['cocos_build_artifacts', 'F47', '构建产物核对', 'build-service'],
      ['cocos_build_list', 'F47', '构建列表', 'build-service'], ['cocos_build_logs', 'F47', '构建日志', 'build-service'], ['cocos_build_cancel', 'F47', '取消构建', 'build-service'],
    ];
    return rows.map(([id, module, title, prerequisite, delegatesTo]) => ({ id, module, title, implementation: 'implemented', verification: 'unverified',
      ...(prerequisite ? { prerequisite } : {}), ...(delegatesTo ? { delegatesTo } : {}) }));
  }
}
