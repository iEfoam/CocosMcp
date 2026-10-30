# 可校验接口示例

由 `node scripts/project-env.mjs node scripts/contract-examples.mjs` 生成。示例只展示参数与结果字段，身份、哈希、图片正文均为占位值，不是原生验收证据，也不能直接用于真实写入。输入与输出在生成前使用当前目录契约校验；操作信封由调用层提供。

## scene.query / common

输入：

```json
{}
```

结果：

```json
{
  "context": "editor",
  "scene": {
    "uuid": "example-scene"
  },
  "dirty": false
}
```

## node.query / common

输入：

```json
{
  "nodeId": "example-panel"
}
```

结果：

```json
{
  "node": {
    "uuid": "example-panel",
    "name": "Panel"
  }
}
```

## asset.location / common

输入：

```json
{
  "url": "db://assets/Panel.prefab"
}
```

结果：

```json
{
  "requestedUrl": "db://assets/Panel.prefab",
  "url": "db://assets/Prefabs/Panel.prefab",
  "folderUrl": "db://assets/Prefabs/",
  "type": "prefab",
  "reuseExistingFolder": true,
  "targetExists": false
}
```

## asset.organize.plan / empty-scope

输入：

```json
{
  "scopeUrl": "db://assets/"
}
```

结果：

```json
{
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rows": [],
  "skipped": [],
  "count": 0,
  "scopeUrl": "db://assets/",
  "referenceNotice": "先审查字符串路径与动态加载，再决定是否执行。"
}
```

## asset.organize.recovery / unknown

输入：

```json
{
  "journalId": "aaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "journalId": "aaaaaaaaaaaaaaaaaaaaaaaa",
  "recordedStatus": "pending",
  "inspectedAt": "2026-10-29T00:00:00.000Z",
  "rows": [
    {
      "sourceUrl": "db://assets/Panel.prefab",
      "targetUrl": "db://assets/Prefabs/Panel.prefab",
      "uuid": "example-asset",
      "state": "unknown"
    }
  ],
  "automaticReplayAllowed": false,
  "limitations": [
    "未完成状态核对，不允许自动重放。"
  ]
}
```

## ui.plan / creator3

输入：

```json
{
  "parentId": "example-canvas",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  }
}
```

结果：

```json
{
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rows": [],
  "parentId": "example-canvas",
  "revision": "example-revision"
}
```

## ui.plan / creator2

输入：

```json
{
  "parentId": "example-canvas",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  }
}
```

结果：

```json
{
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rows": [],
  "mapping": "Creator2.Node-size-anchor-opacity",
  "nativeVersion": "2.4.15"
}
```

## ui.build / unsaved

输入：

```json
{
  "parentId": "example-canvas",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  },
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "rootId": "example-panel",
  "rows": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ],
  "needsSave": true
}
```

## ui.diff / creator3

输入：

```json
{
  "rootId": "example-panel",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  },
  "mapping": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ]
}
```

结果：

```json
{
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rows": [],
  "applicable": true,
  "blocked": [],
  "structuralChanges": false
}
```

## ui.diff / creator2

输入：

```json
{
  "rootId": "example-panel",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  },
  "mapping": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ]
}
```

结果：

```json
{
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "rows": [],
  "structuralChanges": false
}
```

## ui.apply / no-change

输入：

```json
{
  "rootId": "example-panel",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  },
  "mapping": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ],
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "rootId": "example-panel",
  "rows": [],
  "mapping": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ],
  "changed": false,
  "needsSave": false
}
```

## ui.apply / unsaved

输入：

```json
{
  "rootId": "example-panel",
  "document": {
    "version": 1,
    "root": {
      "key": "panel",
      "name": "Panel",
      "components": [
        {
          "type": "cc.UITransform",
          "properties": {
            "contentSize": {
              "width": 400,
              "height": 300
            }
          }
        }
      ]
    }
  },
  "mapping": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ],
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "rootId": "example-panel",
  "rows": [
    {
      "key": "panel",
      "nodeId": "example-panel"
    }
  ],
  "needsSave": true
}
```

## prefab.diff / incomplete

输入：

```json
{
  "nodeId": "example-panel"
}
```

结果：

```json
{
  "nodeId": "example-panel",
  "assetUuid": "example-asset",
  "url": "db://assets/Prefabs/Panel.prefab",
  "sourceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "instanceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "comparisonComplete": false,
  "automaticRepairAllowed": false,
  "rows": [],
  "tree": [],
  "issues": [
    {
      "code": "HIERARCHY_LIST_MISSING"
    }
  ],
  "excludedFields": [
    "_id"
  ],
  "limitations": [
    "快照不完整，不能推断删除。"
  ]
}
```

## asset.references.scan / bounded-review

输入：

```json
{
  "urls": [
    "db://assets/Prefabs/Panel.prefab"
  ]
}
```

结果：

```json
{
  "scopeUrl": "db://assets/",
  "scanComplete": true,
  "referenceCoverageComplete": false,
  "automaticRewriteAllowed": false,
  "rows": [],
  "issues": [],
  "skipped": [],
  "sources": [],
  "targets": [],
  "limitations": [
    "动态加载不能穷举。"
  ]
}
```

## prefab.change.plan / restore-preserves-root-name

输入：

```json
{
  "nodeId": "example-panel",
  "action": "restore"
}
```

结果：

```json
{
  "nodeId": "example-panel",
  "assetUuid": "example-asset",
  "url": "db://assets/Prefabs/Panel.prefab",
  "sourceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceGraphHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "instanceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sceneSavedByTool": false,
  "action": "restore",
  "format": 1,
  "version": "3.8.8",
  "projectPath": "/example/project",
  "preservedRows": [
    {
      "key": "[\"node\",\"root-file-id\"]",
      "kind": "node",
      "status": "property-override",
      "change": {
        "kind": "changed",
        "path": "properties/_name",
        "before": "Panel",
        "after": "MyPanel"
      }
    }
  ],
  "rows": [
    {
      "key": "[\"node\",\"root-file-id\"]",
      "kind": "node",
      "status": "property-override",
      "change": {
        "kind": "changed",
        "path": "properties/_name",
        "before": "Panel",
        "after": "MyPanel"
      }
    }
  ],
  "sourceDependencies": [
    {
      "assetUuid": "example-asset",
      "url": "db://assets/Prefabs/Panel.prefab",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 1000
    }
  ]
}
```

## prefab.change.apply / apply

输入：

```json
{
  "nodeId": "example-panel",
  "action": "apply",
  "expectedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "nodeId": "example-panel",
  "assetUuid": "example-asset",
  "url": "db://assets/Prefabs/Panel.prefab",
  "sourceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceGraphHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "instanceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sceneSavedByTool": false,
  "action": "apply",
  "preservedRows": [],
  "nativeResult": {
    "result": false
  },
  "verification": "source-instance-converged"
}
```

## prefab.change.apply / restore

输入：

```json
{
  "nodeId": "example-panel",
  "action": "restore",
  "expectedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

结果：

```json
{
  "nodeId": "example-panel",
  "assetUuid": "example-asset",
  "url": "db://assets/Prefabs/Panel.prefab",
  "sourceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sourceGraphHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "instanceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "expectedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "planHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sceneSavedByTool": false,
  "action": "restore",
  "preservedRows": [
    {
      "key": "[\"node\",\"root-file-id\"]",
      "kind": "node",
      "status": "property-override",
      "change": {
        "kind": "changed",
        "path": "properties/_name",
        "before": "Panel",
        "after": "MyPanel"
      }
    }
  ],
  "nativeResult": {
    "result": true
  },
  "verification": "source-instance-converged-with-preserved-properties"
}
```

## preview.capture / managed

输入：

```json
{
  "target": "embedded"
}
```

结果：

```json
{
  "captureId": "example-capture",
  "capturedAt": "2026-10-29T00:00:00.000Z",
  "source": "managed-preview-window",
  "width": 1,
  "height": 1,
  "dataUrl": "data:image/png;base64,dGVzdA==",
  "imageDelivery": "image",
  "image": {
    "mimeType": "image/png",
    "byteLength": 4,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "stale": false,
  "frameBinding": "draw-observed-before-composite",
  "exactPixelFrameIndex": null,
  "verification": "rendered-frame-captured",
  "businessOutcomeVerified": false,
  "layoutVerified": false
}
```

## preview.capture / external

输入：

```json
{
  "target": "external-browser"
}
```

结果：

```json
{
  "captureId": "example-capture",
  "capturedAt": "2026-10-29T00:00:00.000Z",
  "source": "scoped-browser-connector",
  "width": 1,
  "height": 1,
  "dataUrl": "data:image/png;base64,dGVzdA==",
  "imageDelivery": "image",
  "image": {
    "mimeType": "image/png",
    "byteLength": 4,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```
