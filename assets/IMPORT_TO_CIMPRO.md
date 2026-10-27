# 验证潜艇模型导入孪大师（CIMPro）客户端

本目录已生成可导入资产，用于开发流验证（非外观精模）。

## 文件

| 文件 | 作用 |
|------|------|
| `models/sim_submarine_verify.gltf` + `.bin` | 分层命名潜艇（设备节点 + 相机标记 + 航路点 + 阶段条） |
| `mapping/equipment-map.json` | 设备名/ID ↔ 场景对象名，与 Vue 联调页共用 |
| `models/generate_submarine_gltf.py` | 需要改尺寸/节点时重新生成 |

## 导入步骤（客户端）

1. 打开 **CIMPro 孪大师**，登录后 **新建项目**（或打开已有验证工程）。
2. 菜单中找到 **导入模型 / 数据导入**（不同版本入口可能在「资源」「数据管理」或工作台上传）。
3. 选择：
   - `D:\SC\SCCODE\DigitalTwin\assets\models\sim_submarine_verify.gltf`
   - 同目录的 `.bin` 需与 `.gltf` 放在一起（已放好，不要只拷 gltf）。
4. **合并方式务必选「不合并」**，否则节点名会丢，后面 API 对不上。
5. 导入后在 **大纲视图** 确认存在：
   - `SimVerifyRoot` → `Sub_Hull` → `Eq_229_Qianfu` … `Eq_228_Propulsion`
   - `Cam_*_Marker`、`WP_1~3`、`Phase_Banner_552/553/554`
6. （可选）用资源包里的海面/天空替换空白环境；本 glTF 不含海面。
7. （可选）在客户端为各 `Eq_*` 再做一套「故障红闪」材质，正常态保留现有颜色。
8. 在客户端创建 **固定相机**，位置可参考场景里的 `Cam_*_Marker` 小球，命名建议与 Vue 一致：
   - `Cam_Overview` / `Cam_Side` / `Cam_Detail` / `Cam_FaultFocus`
9. **保存工程**。后续云渲染或内嵌二次开发都加载该工程。

## 导入后自检

- 大纲里能点选 `Eq_228_Propulsion`（推进电机占位块，艇尾红色）。
- 对象名称与 `equipment-map.json` 的 `target` 字段完全一致（区分大小写）。
- 不要整体合并网格；若误合并，重新导入。

## 与仿真系统的对应关系

- 试验方案 / 模型集 / 启停：在 Vue 页操作，走 `underwater-mock` REST。
- 位姿 / 阶段：WS `/ws/mock` → 驱动艇体或阶段条显隐。
- 故障：WS `/mw/ws/results` → 按 `equipmentName` 映射到 `Eq_*` 高亮。

Vue 联调页：`DigitalTwin/digital-twin-frontend` 路由 `/sim-verify`。
