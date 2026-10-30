/** 所有 MCP 入口共享静态 UI 策略，避免路由入口与单工程入口给出不同的搭建建议。 */
export class UiAuthoring {
  static readonly instructions = '静态 UI 默认用 ui.plan/build 创建场景节点，已有 UI 用 ui.diff/apply；完成后 scene.save 或 prefab.create 并读回核验。脚本仅负责交互与动态内容；能力缺口先说明，不默认改为运行时生成整页 UI。';
}
