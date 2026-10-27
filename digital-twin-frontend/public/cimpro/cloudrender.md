# Cloudrender 使用说明

面向外部调用 `PiClient.cloudrender.init(options)` 的参数与示例。适用于浏览器端直连云渲染（非 UE 内部）。

## 必填参数
- `address: string`：信令 / 云渲染服务地址，例如 `wss://signal.example.com`.
- `projectId: string`：项目 ID（来自云端管理后台）。

## 常用可选参数
- `mode?: string`：`pixelstreaming` 或 `embed`，未传或非 `pixelstreaming` 时自动回落 `embed`。
- `appKey?: string`：云渲染 appKey。
- `$el?: HTMLElement`：视频元素挂载容器，默认 `document.body`。
- `accountId?: string`，`accountName?: string`，`token?: string`（编辑模式必填）。
- `showUI?: boolean`，`editorMode?: boolean`。
- 回调：
  - `onDisconnect?(msg: string)`：断开时回调。
  - `onProgress?(percent: number)`：连接进度 0-100。
  - `report?(state: CloudrenderReport)`：实时状态（fps/latency/bitrate 等）。
- `initialSettings?: PixelStreamingInitialSettings`：透传给 Pixel Streaming 前端的初始化配置（详见下方）。

## PixelStreaming initialSettings
所有键均可选，未提供时使用默认值。类型与默认值如下：

### 布尔 Flags
- `AutoConnect` (default `false`)：自动连接。
- `AutoPlayVideo` (default `true`)：自动播放视频。
- `OfferToReceive` (default `false`)：浏览器发起 offer（BrowserSendOffer）。
- `UseMic` (default `false`)：请求麦克风。
- `StartVideoMuted` (default `false`)：视频初始静音。
- `SuppressBrowserKeys` (default `true`)：屏蔽浏览器快捷键。
- `ControlsQuality` (default `true`)：作为编码质量控制端（IsQualityController）。
- `ForceMonoAudio` (default `false`)：强制单声道。
- `ForceTURN` (default `false`)：仅使用 TURN。
- `TimeoutIfIdle` (default `false`)：空闲超时检测（AFKDetection）。
- `MatchViewportRes` (default `false`)：匹配视口分辨率（MatchViewportResolution）。
- `HoveringMouse` (default `false`)：悬停鼠标模式。
- `FakeMouseWithTouches` (default `true`)：触控模拟鼠标。
- `KeyboardInput` (default `true`)：允许键盘输入。
- `MouseInput` (default `true`)：允许鼠标输入。
- `TouchInput` (default `true`)：允许触控输入。
- `GamepadInput` (default `true`)：允许手柄输入。
- `XRControllerInput` (default `true`)：允许 XR 控制器输入。
- `WaitForStreamer` (default `true`)：等待可用 streamer。

### 数值 Numeric
- `AFKTimeout` (default `120`)：空闲超时秒。
- `MaxReconnectAttempts` (default `3`)：最大重连次数。
- `MinQP` (default `0`)：最小 QP。
- `MaxQP` (default `51`)：最大 QP。
- `WebRTCFPS` (default `60`)：目标 FPS。
- `WebRTCMinBitrate` (default `0`)：最小码率 kbps。
- `WebRTCMaxBitrate` (default `0`)：最大码率 kbps。
- `StreamerAutoJoinInterval` (default `3000`)：自动加入间隔 ms。

### 文本 / 枚举
- `ss`：信令服务器 URL，默认取 `initialSettings.ss` 或 `options.address` 或 `当前页面协议/主机/端口`。
- `PreferredCodec` (default `H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`)：首选编码。
- `StreamerId` (default `''`)：指定 streamer。

## 使用示例
```ts
import { PiClient } from './src/index'

const client = new PiClient({ debug: true })

client.cloudrender.init({
  address: 'wss://signal.example.com',
  appKey: 'demo-key',
  projectId: 'proj-123',
  mode: 'pixelstreaming',
  $el: document.getElementById('player')!,
  editorMode: true,
  token: 'token-xxx',
  initialSettings: {
    AutoConnect: true,
    MatchViewportRes: true,
    WebRTCFPS: 30,
    WebRTCMaxBitrate: 8000,
    PreferredCodec: 'H264 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  },
  onDisconnect: (msg) => console.warn('disconnected:', msg),
  onProgress: (p) => console.log('progress:', p),
  report: (state) => console.log('stats:', state),
}).then(() => {
  console.log('cloudrender ready')
}).catch(console.error)
```

