# Cloudig production UI foundation

这里是采云 V1.0 的共享生产设计层，不是演示页，也不保存模拟业务数据。

- `tokens/cloudig-tokens.css`：老婆定稿的品牌色、双主题语义、字体、窗口、阴影、动效和层级令牌。
- `components/cloudig-foundation.css`：带 `cloudig-` 前缀的按钮、焦点、滚动区、单行长文本与提示公共件。
- `runtime/viewport.js`：以 `visualViewport` 为优先事实，向根节点写入真实可用宽高、偏移、DPR 与视口档位。
- `assets/welcome/`：从只读美术源精确复制的 Welcome 首批 12 个定稿素材；这里只保存运行时确实要用的副本。
- `build.mjs`：确定性同步到 `manager/web/shared/` 与 `manager/web/assets/welcome/`；生成清单不含时间、绝对路径或私人信息。

运行 `node ui/build.mjs` 更新 Manager 运行文件；`node ui/build.mjs --check` 只核对，不写入。Reader 在逐页生产化时从同一源内联所需令牌，不复制第二套设计事实。

正式几何、渐变、阴影与素材仍以老婆的总规格和只读 `.ai` / `.png` 为权威。公共层只收已经跨页面成立的规则；页面专属数值留在页面作用域，避免把一次视觉猜测固化成全局规范。
