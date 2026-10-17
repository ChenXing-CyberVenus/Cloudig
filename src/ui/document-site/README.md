# 采云同源文档网页

维护：GPT-6-Astra·奥思·承卷开霁 Osis.ScrollborneDawn，2026-09-22。

只负责网站外框、路由与浏览器适配。文档正文、插图、目录/四档折叠、主题CSS和Reader组件仍直接取自生产模块，禁止在这里维护第二套正文或另画一套采云主题。

- 构建：`node scripts/build-document-site.mjs`，默认GitHub项目站点子路径 `/Cloudig/`。
- 本地查看：`node scripts/serve-document-site.mjs` → `http://127.0.0.1:4178/Cloudig/`。
- 交付：唯一派生目录 `artifacts/v1-document-site/`；公开仓库 `ChenXing-CyberVenus/Cloudig` 的 `main:docs/` 只接收其完整内容，不上传整个工程或内部 Git 历史。GitHub Pages 从该目录部署至 `https://chenxing-cybervenus.github.io/Cloudig/`。
- 范例来源：已发布 `releases/1.0.0/Cloudig/docs/examples/` 的38份HTML/JSON，逐字节校验后原样复制；不访问私人Sample/Library，不重跑Parser，不改签名载荷。
- 阅读投影：与桌面共用 `view-model-core.mts`；完整记录校验仍由桌面入口承担，网页构建时先对有限范例执行完整校验。网页无Engine、IPC、资料库或编辑权限。
- 部署适配：构建时只将应用 `/pages/`、`/assets/`、`/runtime/`、`/shared/` 等根路径前缀转换为站点子路径。原HTML/Conversation不做替换。
- 发布清单：`site-manifest.json`登记来源和文件SHA；首次默认Dawn，主题/语言偏好仅留浏览器。

网页验证用真实浏览器与实际指针；不把jsdom/构建检查称为视觉验收。签名安装包不重建，是否公开部署以老婆指示为准。

发布时保持文件字节：暂存静态输出使用命令级 `core.autocrlf=false`，用发布清单和 Git blob 核对；第三方许可/原始范例保留原有换行，不为消除空白提示重写。发布只使用独立的公开仓库临时检出；完成远端与实页核验后退役该自产检出，保留固定站点输出、Git 提交与本轮证据，不累积重复大目录。
