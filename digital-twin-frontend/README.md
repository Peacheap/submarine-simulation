# digital-twin-frontend

CIMPro 孪大师 × underwater-mock 开发流验证前端（Vue 3 + Vite）。

## 已准备内容

| 路径 | 说明 |
|------|------|
| `/sim-verify` | 选方案、启停 Mock/联合仿真、收 WS、映射设备高亮 |
| `src/config/equipment-map.json` | 设备 ↔ 场景对象名 |
| `../assets/models/sim_submarine_verify.gltf` | 导入孪大师的分层潜艇 |
| `../assets/IMPORT_TO_CIMPRO.md` | 客户端导入步骤 |

## 启动

1. 确保 `underwater-mock` 在 `9090` 运行（及 A 项目/DDS 若要跑通联合仿真）。
2. 本目录：

```bash
npm install
npm run dev
```

3. 浏览器打开提示的地址（默认 `http://127.0.0.1:5173/sim-verify`）。
4. 默认 **preview** 模式即可验证 REST/WS；孪大师场景导入后，再切 `embed` 或 `cloud`。

## 孪大师侧

见 `DigitalTwin/assets/IMPORT_TO_CIMPRO.md`：导入 glTF，合并方式选 **不合并**。
