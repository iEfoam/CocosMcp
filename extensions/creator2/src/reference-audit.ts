import { SerializedReferenceAudit } from '../../../packages/ui-core/src/reference-audit.js';

/** 保持 Creator 2 原入口；序列化扫描与事件引用守卫由两版共用。 */
export class Creator2ReferenceAudit extends SerializedReferenceAudit {}
