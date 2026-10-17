# AI Chat Archive Reader

> 库存说明：下文Reader 0.7、独立reader.html和旧格式兼容不代表当前V1桌面Reader。现行代码为[`src/app/reader`](../src/app/reader)、[`src/ui/shell/pages/reader`](../src/ui/shell/pages/reader)和[`src/ui/shared/conversation-renderer`](../src/ui/shared/conversation-renderer)；V1不交付Portable Reader。已验收美术派生可按明确清单复用，不让库存代码自动回到生产图。

Reader 0.7.0 是一个只读取统一 JSON 的完全离线阅读器。它保留 `conversation/0.1.0`–`0.2.5` 全部旧格式只读兼容，并读取 `conversation/1.0.0`：V1 嵌套的身份、生命周期、采集依据和内容时间会被投影到同一阅读模型。桌面 Reader 的 V1 编辑与内容时间入口跳转到 Manager 唯一的 Library 1.0 事务界面；便携 Reader 保持只读，不复制第二套写实现。

Reader 0.7.0 已内嵌同一份 `CloudigTimeCore 1.0.0` 与机器常数；时间正序/倒序、BC/AD、模糊区间、relative、unknown 和拥有直接 Terran mapping 的 Sovereign 不再由 Reader 自己换算一个 Number。Catalog 1.0 只给 Sovereign 投影保留 binding、显示标签、直接排序描述符与 snapshot SHA，不复制完整时间图或快照 payload。

十二站书签集合 `2026.08.08.1` 的 32 份导出器已通过用户验收；它们的 HTML 输出语义和
Reader 交接边界见
[`../docs/2026-07-29_十二站书签全轨用户验收与采云总工程交接-GPT-5.6-Sol.md`](../docs/2026-07-29_十二站书签全轨用户验收与采云总工程交接-GPT-5.6-Sol.md)。
这不等于 Reader 0.7.0 的 Windows 表现或任何冻结发布包已经对该新集合完成独立验收。

Reader 0.7.0 在上述工具栏交互与 `parser_adapter` 兼容信息基础上，原位呈现 ChatGPT Scheduled 任务定义和“已安排”列表；内部任务项仍用离线 `<details>` 展开，不把整张卡压成普通工具摘要。自动运行沿用一个 AI 头像一轮的规则，任务名显示在平台身份旁。`other + name` 的第三方参与者继续作为独立角色进入时间线、搜索和 Markdown，不映射成主要用户或助手。Escape 仍可明确关闭。

当前 Reader Conversation 视觉候选使用正式 Dawn / StarNight 标题、工具栏和右侧路标素材；用户气泡按 12 平台分别着色，AI 最终正文直接落在阅读背景。同轮思考、工具、来源和状态保留为独立过程节点，只生成一个 AI 正文节点；右侧用户、智能和过程筛选仅改变路标，不删正文，智能关闭时过程筛选随之关闭并禁用。工具栏由单一 21 px 主题纹样覆盖 48 px 横栏，搜索、前后命中与两个 123 px 菜单在 1920×1080、1440×900、1280×720 都保持同一条 32 px 控制轴；正式默认用户头像与 Reader Cover 共用 `OsisLogo-Cloudig-1024.png`，已知平台助手仍显示自己的平台头像。当前只是机器候选，仍待 Windows 视觉与交互验收。

Reader Cover 的动效只作用于装饰与纯光层，不移动目录、标题、相框、电脑或任何点击热区，也不对含文字的场景切片做透明度动画。破晓窗光复用老婆切出的 `500×630` 窗户 SVG，并按成品画板实际位置 `96,160` 对齐；从正式场景确定性提取的透明前景切片保持同一坐标并覆盖在光层上方，因此文字、Logo、花与电脑不会再被光斑遮住。窗光动画峰值的主透明度现为 `.4`；额外亮度与饱和度仍为 `1.192 / 1.064`。两主题微尘都分布到完整 1272×1032 场景，每粒使用独立的多段位移、周期和错峰延迟；粒子直径统一放大 35%，本体与透明轮廓亮度同步增强。星夜鹦鹉使用正式 `RCSS-鹦鹉.svg`，按原图匹配坐标 `581,423` 置于屏幕上方；一个 z1、`158×151 @ 579,421` 的裁切底层按正式坐标依次重投影 `RCSS-星夜窗户.svg`、`RCSS-时光建筑群.svg` 与 `RCSS-桌面与电脑-黑灯.svg`，完整重建鹦鹉后方至脚底的窗景、城市及显示器上框，z2 光锥屏幕再覆盖其上，页面才显示唯一动鸟。现行整鸟围绕脚底以 6.4 秒周期完成明显但稳定的吸气—呼气：吸气舒张到 `scale(1.014,1.028)`，呼气回收到 `scale(.997,.99)`，横向换重心不超过 `.65px` 且所有相位纵向位移恒为 0；头部用同一 6.4 秒节拍协调环顾，尾羽维持 15.2 秒低频轻摆，旧 `-9px` 跳跃保持删除。破晓场景中原本烤进背景的背面三花猫，则以纯净墙面补片、肥肥相片、相框和独立猫 SVG 在同一坐标确定性重建；墙面补片现按原 Illustrator 阴影外界扩大为 `210×66 @ 680,20`，边缘全部落在真实纯色墙面而不再切穿阴影形成矩形。猫身与双耳保持静止，只让棕色尾巴、尾端白斑和尾根白斑共用一套 5.8 秒矩阵摆动，不凭空增加眼睛。尾巴左摆会越过原 SVG 的 `x=0`，工程派生因此把视口扩成 `-20 0 157.7 216.29`，外层盒同步向左扩 20 px、向下扩 8 px，原始猫身坐标不变而越界尾巴不再被矩形裁切。工程猫 SVG 已移除会随尾巴重算并膨胀的 Illustrator 滤镜，改由外层透明轮廓统一绘制明显的 `drop-shadow(8px 9px 11px rgb(50 35 25 / 55%))`；它不是矩形 `box-shadow`，因此可以恢复大范围体积而不形成方框。老婆的美术源文件保持只读，工程内两份动画派生都在 SVG 内自带 reduced-motion 门禁。音频联动不再目测定位：破晓正式 SVG 的扬声器圆心为 `(904.20,788.07)` / `(1138.69,788.07)`，调谐指针为 `1.65×22.76 @ 1021.28,764.85`；星夜正式 SVG 的音响圆心为 `(392.01,789.68)` / `(980.10,789.68)`。透明振膜按 5.6 秒音符周期错峰联动，破晓使用更强的红色轮廓、光晕、峰值与摆幅，星夜保持克制。被老婆退回为“像扫描线”的 StarNight 水波结构与全部样式已经完整移除。两主题管理档案屏幕共用 5.2 秒常规扫光；鼠标悬停或键盘聚焦时，另在屏幕内部触发一次 0.92 秒唤醒扫光和环境亮度，不改变按钮几何。风铃保持 12.8 秒连续非等幅摆动，人物入口柔光、星点和条件蝴蝶继续保留。右下联系作者卡的中文作者名与场景中央用户 / 智能相框名是两个独立对象；当前对照候选只把 `.rr-contact strong` 从 16 px 设计基准暂降为 10 px，相框名称已恢复原有字符分档，避免把联系作者截断误修到人物入口。离开 Reader Cover 后页面层动画暂停；系统启用 `prefers-reduced-motion: reduce` 时关闭页面与派生 SVG 的循环、音符和扫光并保留稳定静态提示。它不改变正式两主题场景、响应式缩放、点击坐标或离线边界，仍需老婆在真实 Windows 窗口判断最终动感与幅度。

Reader 的首屏不再边请求资料库边裸露半挂载封面。构建器把 `Waiting-Sun.gif` 以 `image/gif` 原字节嵌入成品，`cloudig-boot-screen` 在正文之前占满窗口；遮罩使用 GIF 90 帧实际画布色 `#020002`，而不是肉眼近似的 `#000`。独立离线 Reader 仍等待默认目录、内嵌 Library、当前非懒加载图片、字体与连续两帧绘制就绪，再由网页太阳一次性揭开完整页面。窗口内 Reader 则由 Windows 壳注入专用转场标记：Reader → 档案馆先把正文 140 ms 淡到同色近黑，再由唯一的原生太阳淡入并持续到目标页启动完成；目标网页太阳始终不露出，原生太阳淡出后正文以 180 ms 淡入。档案馆 → Reader 的构建等待只显示档案馆当前那枚太阳，进入文档交换后再平滑交给唯一原生太阳，不出现第二个网页太阳。

## 直接使用

当前 35 份 Light / Full / AllBranches 私有批次首先验证 Parser 三轨输入与统一 JSON；Reader 的逐页内容基线仍使用 `tests/private/AIChatArchive-Reader.html` 内嵌的 12 份代表 JSON。双击后会自动载入完整代表会话库，不选择目录、不复制路径、不逐个打开 JSON，也不需要浏览器授予磁盘目录权限。“更改目录”和“追加 JSON”仍可临时查看其他档案。

公开的 `reader/reader.html` 是不携带私人数据的通用版：首次选择一个档案目录后，它会递归读取其中全部 `.json`。支持 File System Access API 的 Chromium 浏览器会把授权目录句柄保存在本机 IndexedDB，以后主按钮直接打开；“更改目录”可替换。其他浏览器回退到一次选择整个目录的 `webkitdirectory`。浏览器不允许普通本地 HTML 用任意 `G:\...` 字符串强制取得目录权限，所以通用版不会伪造“写死路径”；需要零选择体验时，应构建下面的内嵌档案库版本。

Reader 以会话 `schema` 作为逐篇兼容门槛，当前接受 `conversation/0.1.0`—`0.1.5`、`conversation/0.2.0`—`0.2.5` 与 `conversation/1.0.0`。只要 schema 受支持，即使档案记录的 `parser_version` 高于当前 Reader 也照常读取；遇到未知或更新的 schema 时只隔离该篇，不阻断同一目录中其他会话。0.1.5 / 0.2.5 必须带合法时区的 `parsed_at`；旧 schema 不伪补该字段。语法损坏或结构校验失败的 JSON 同样保留为禁用目录项，但不会泄露正文、标题或校验细节，也不能成为编辑、Markdown 导出或“打开当前 JSON”的目标。Reader 自身版本、`parser_version` 与当前 schema 必填的 `parser_adapter.version` 使用完整 SemVer 口径；schema 使用原始字符串精确匹配；可选 `exporter_version` 至少必须包含一个非空白字符。目录区会常驻显示轻量的“有 N 篇需要更新或修复”条幅，不自动弹出遮挡阅读；用户点击后才查看文件名、schema、总 Parser、来源适配器与当前 Reader 版本。Reader 不提供把新格式降写成旧格式的功能。

Reader 不解析原始网页，也不运行 JSON 中的脚本。外部图片只显示地址卡片；只有已写入 JSON 的 `data:image/...` 资源会生成缩略图。引用、搜索结果与附件 URL 仅在用户主动点击时才交给浏览器打开。

Reader 只把确实影响档案阅读或完整性的 `warnings` 显示为“档案完整性提示”。工程代码保留在条目元数据中，不混入正文；A-Light 的既定附件策略、原网页字体抓取和成功的无损排版修复不会显示成面向用户的警告。

## Cloudig 资料库候选

Reader 兼容读取 `cloudig/library` `0.1.4` 与 `1.0.0`。选择整个扁平 `Cloudig/` 根目录或能够递归包含它的目录时，Reader 会定位根层 `cloudig-library.json`，只载入同一根下 `Conversations/` 的统一会话，并忽略 `Inbox/` 里的待解析文件和 `Data/parse-state.json` 等自动状态。Reader 永远不初始化或改写资料库；空旧根到 V1 的初始化只属于 Manager。

Library 只覆盖阅读视图，不改 Parser 事实 JSON。目前可编辑会话标题、内容时间、提供方、平台、模型、用户/助手称呼、界面语言与主题。用户标题写入稀疏 `conversation_name`，有效标题为 `conversation_name ?? title`；清除覆盖后恢复 Parser 事实 `title`。名称与头像按“会话名称 > 应用到全部对话的全局身份 > 平台身份 > 未应用到全部对话的全局缺省 > 内置来源身份”解析：全局窗口可编辑用户/助手名称与头像及 12 个平台注册项，会话窗口只增加该会话的用户/助手名称，不增加会话头像。上传项右上角删除、恢复默认或清空输入都删除对应稀疏字段，不写空壳。英文内置默认称呼固定为 `User / AI`。编辑界面显示当前实际 JSON 文件名，并明确说明标题编辑不会重命名文件。内容时间覆盖最高优先，目录排序也使用最终生效值。V1 会话在桌面端通过 Manager 的 `conversation.metadata.commit` 同时使用 Library / Conversation SHA 与 `archive_id` 提交；便携 Reader 不伪装具备这项跨文件事务能力。旧格式通过 File System Access API 取得原文件写权限时，Reader 只重写 `cloudig-library.json`；没有可写句柄时会下载新的替代文件并明确提示，不伪称原位保存。“打开 JSON”始终指向未合并覆盖的事实层。

会话条目以 `conversation_key` 为稳定身份；旧 `conversation_id` 与普通旧文件的 `source_sha256` 继续兼容。当前 JSON 物理文件名只作运行时定位，不写回会话或 Library。未确认名称规则时，Reader 在每次资料库载入中只检查一次有效标题与当前 JSON 文件名 stem；发现首个不一致才显示说明。只有勾选“已阅，不再提示”并关闭，才把 `preferences.name_rule_ack_version: 1` 写入 Library；关闭、窗口按钮与 Esc 不会自动改名。

V0.10.0 候选的采云窗口内 Reader 与便携 Reader 继续使用同一个构建器和 `reader/src/`，但不再使用同一种数据装载方式。桌面模式生成可重建的 `Data/Reader/Cloudig-Reader.html`，只嵌入 Library、当前引用资产与固定离线运行时；启动目录来自 `Data/Indexes/conversation-catalog.json` 的 Archiver 投影，标题搜索、排序和平台筛选不读取正文。用户点开某篇时，`reader.read-conversation` 携带目录 SHA-256，只允许受限本地桥读取 `Conversations/` 内这一篇；文件已变化、被移走、越界、链接逃逸、Schema 不兼容或结构损坏时拒绝显示并要求刷新。切换会话或返回 Reader Cover 后，上一篇正文、资源表、来源表、消息 DOM 与全文搜索缓存不再留在目录状态中。显式生成的 `Exports/Cloudig-Reader.html` 仍完整内嵌当时所有现存会话，是用户可复制、可双击的便携快照；没有第二套渲染器。

Manager 打开任何 Reader 都不调用 Parser、不刷新 `Data/parse-state.json`，也不恢复用户手动删除的 JSON。缺失输出只在管理中心显示为待解析，必须由用户明确点击解析后才能恢复。Reader 只在精确的 `https://reader.cloudig.local/Cloudig-Reader.html` 本地页上启用返回采云主页、单篇读取、原生资产选择和覆盖层写回适配，隐藏浏览器目录选择与下载控件，并通过受限的 `reader.library-info` 原生桥接在内部封面显示当前真实资料库路径；独立内嵌版只显示“内嵌默认档案库”。Manager 同时把当前 `dawn / star_night` 主题作为受校验的 Reader URL 参数传入；Reader 在内联 CSS 之前把它映射为 `light / dark`，无参数时才读取本地偏好或平台主题，因此星夜入口不会先绘制一帧破晓。桌面资料库为 0 篇会话时，内部封面在原有两个按钮之前显示印章红“采集与解析”，直接回到 `index.html#manager`；通用 / 独立 Reader 不显示无效入口。写回只接受 Reader 打开时内嵌的 Library SHA-256 水位；若根层 `cloudig-library.json` 已被别处修改，客户端拒绝覆盖并要求重新打开 Reader。三种入口因此保持同一内容语义，同时各自使用合适的文件权限路线。

旧版 JSON 不在 V0.10.0 当前生成或发布门禁；现行门禁覆盖 35 份三档 HTML 经 Parser 0.5.0 新生成的 JSON。测试以注入时钟固定 `parsed_at`，其余语义保持确定；Reader 保留的旧 schema 只读能力不扩张为旧 Parser 回写工程。Cloudig Manager 已接通固定品牌资源和用户/助手/平台注册头像：图片进入 `Data/Assets/`，Library 只保存安全相对路径，构建器只把当前引用资产嵌入 Reader。内置豆包身份使用 V0.8.0 更新后的头像资源；自动回归通过不等于用户视觉验收。

Reader 载入资料库后先显示自己的内部封面，不自动打开第一篇会话；正文右侧“返回封面”只返回这个 Reader 内部封面。Reader 顶栏左侧的红色旋涡与“采云”品牌组在窗口内版点击后返回应用的大型渐变主页封面，两种返回语义不混用。目录可筛选、展开、折叠，条目只显示标题、平台图标、模型、内容日期和按轮次统计的消息数。折叠只收起目录，保留当前会话、正文、路标、滚动位置、搜索、筛选和排序；折叠后的窄边缘入口保持可见可点，可恢复折叠前宽度。

采云窗口内 Reader 已接通真实目录管理：目录区的“新建目录 / 管理目录”读取当前档案 revision，可创建一级目录、改名，并在第二次明确点击后删除完全空且不含子目录的目录；外部嵌套目录只读。会话条目的“移至目录”二级菜单可移入现有一级目录、移回 `Conversations/` 根目录，或先创建目录再移入。全部写操作复用 Archiver 的相对路径、资料库事务锁、Parser 输出路径重写和 revision 冲突门禁，不改变 `conversation_key`、Parser 会话 JSON 或 Library 用户覆盖。独立 HTML Reader 没有原生事务边界，因此只提供目录筛选与展开，不显示会误导用户的写入按钮。

用户消息使用平台色气泡；AI 消息直接排在阅读背景上。一整轮 AI 回复无论包含多少思考、搜索、工具调用与结果，都只算一组，只在组首显示一次完整平台头像。Kimi 同轮思考合并为一个默认折叠入口，`tool` / `search` 过程按 Parser 0.4.1 恢复为紧凑活动，代码源码与运行预览同时呈现；最终回答才进入正文。ChatGPT 思考状态、合法时长和正文进入同一个默认折叠块，`bio` 是折叠工具活动，Canvas / writing block 是独立文稿。元宝的 22 份正文静态公式与 21 份思考静态公式留在原作用域；Mistral Canvas 的 4 份局部 CSS 仅作用于对应 Canvas，5 个标签保持语义结构。组内活动只使用小圆点或极小功能图标，并保持可折叠、可搜索和原始顺序；思考与工具卡和最终正文共用同一左边界，不再额外缩进。标题、黏性工具栏、分支/提示和正文时间线共享一条最大 1500 设计像素的阅读列，Windows 缩放时按 `devicePixelRatio` 换算；顶栏三个档案操作按钮的右边缘对齐中央 Reader 外容器的右边界，也就是右侧路标左边的分隔线，不对齐内部 1500 阅读列。搜索框、命中导航和“展开思考与工具”“隐藏思考与工具”两个主按钮在桌面布局始终保持一行；指针进入任一主按钮所在的完整控件后，按钮在原位置换成同宽复选项，指针留在按钮或选项共同占据的控件区域内可连续操作，离开整个控件才恢复按钮。键盘焦点提供等价入口，`Escape` 可恢复；点击只作为键盘/触摸后备，不形成离开后仍锁定的菜单。展开项分别控制思考、工具、参考；隐藏项只隐藏思维或工具节点，不误伤搜索与引用，且五项默认都不勾选。只有思考状态和时长、没有思维正文的独立过程条同样属于“隐藏思维”，隐藏后保留同轮最终正文。最小 800 px 应用窗口下目录改为不占文档流的抽屉，正文标题不被下推，工具行也不制造第二行或横向溢出。右侧路标只显示用户正文或 AI 最终正文，不显示角色、块类型、思考、状态或工具信息；取消用户或智能后，对应条目连同轮次数字完整隐藏。当前激活项跟随正文视口中最上方的可见消息滚动更新，不要求用户点击导航。路标勾选不联动正文。“采集与解析”直接进入 Parser 管理页，不回应用封面。

展开目录严格沿用 `Cloudig-Reader-Interaction.ai/.png` 的书架语义，不使用带标题和关闭叉的通用弹窗：顶部四个常用目录与新建/展开/管理操作保留原位，其余目录按每层三列两行、每六项一层生成书架；同层编号靠前的三项先贴住木轨下排，后续三项才叠到上排，明确从木架向上生长。书背形态和颜色是两个独立维度：下排固定使用开口向右的 `02 / 04`，上排固定使用开口向左的 `01 / 03`；选中态按棋盘交错为下排 `02 / 04 / 02`、上排 `01 / 03 / 01`，因此 Dawn 呈红/蓝交错、StarNight 呈橙/紫交错，未选中态只按行固定方向。展开区和固定底栏使用目录选择区正式底色，Dawn 为 `#AE8B7F`、StarNight 为 `#3B383C`；14 px 木轨分别为 `#D3AF95 / #555960`，不做半透明混色。目录列表是唯一滚动拥有者；底部确认区固定在侧栏底边，不随目录滚动。确认使用主题填色按钮，取消使用同主题 2 px 线框按钮；条目点击只修改草稿选择，确认才应用，取消与 `Escape` 均丢弃草稿。

目录滚动层为系统 thin 滚动条在左右各保留同宽沟槽，条目再使用对称余量，因此有无溢出、最大化或窗口化时，条目可见外边距都保持 16 / 16 px。目录与正文滚动条使用低对比度主题色；消息导航的滚动条在闲置时完全透明，只在鼠标进入该栏或键盘焦点进入时显示。红边操作按钮显式允许合成粗体，避免 FangSong 在根级 `font-synthesis: none` 下看起来仍像常规字重。

正文 `.conversation`、`.message-body`、`.prose` 使用 `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`，基准 `15px / 1.78 / 400`；会话标题和 Markdown 标题使用 `Georgia, "Songti SC", serif`。这是源码声明栈；没有读取实机 `getComputedStyle()` 前，不声称 Windows 最终解析为其中哪一种字体。

## 离线运行时

- Markdown：内嵌 `markdown-it 14.3.0`，关闭原始 HTML，支持 CommonMark、表格、删除线、任务列表、围栏代码与安全链接。
- TeX/LaTeX：内嵌 `Temml 0.13.3`，输出 MathML；支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、常用数学环境、公式框、标签，以及 theorem/lemma/proof/corollary/quote 等文档型环境的语义投影。对来源已经排版、没有可恢复 TeX 的静态 KaTeX，构建器另内嵌固定 KaTeX CSS 与 12 份 WOFF2 字体，完全离线恢复原几何，不请求 CDN。
- 富内容：代码、AI 生图、上传图片、普通附件、搜索、引用、思考、状态、工具活动、静态 SVG 图表、安全富文本和未知组件保底卡片。思考、搜索、工具与引用默认折叠，正文和来源在用户展开时才生成。
- 时长：只显示严格大于零的已记录时长；旧 JSON 中的缺失值或零值不会显示成 `0 ms`。
- 页面：zh-CN/en 内嵌语言包、Dawn/StarNight/跟随系统主题、内容时间正序/倒序/标题排序、默认全选且以印章红标示的多选平台筛选、可调可折叠目录、会话库与正文搜索、搜索命中前后导航、思考与活动折叠、内容摘要路标、Markdown 查看/复制/保存、打印样式和移动端布局。
- 分支：ChatGPT、DeepSeek、Grok、Kimi、Qwen、Z.ai、Mistral、Claude 网页 AllBranches 与 Claude 官方灾后恢复都写入 `conversation/0.2.5` 父链；Reader 默认显示来源当前叶，允许切换其他叶路径并跨分支搜索。Light / Full 使用 Flat 0.1.5，不出现虚构分支。既有 0.1.0—0.1.4 与 0.2.0—0.2.4 继续只读兼容。

最终 `reader.html` 不含外部脚本、样式表或字体地址，并带有 `connect-src 'none'` 的内容安全策略。

## 从源码构建

```powershell
npm ci
npm run build

# 把某个 JSON 目录写进一个可双击即读的便携 Reader
node .\reader\build.mjs --library-dir ".\converted" --output ".\AIChatArchive-Reader.html"

# 仅供 Cloudig Desktop 内部构建目录先行壳；普通用户不需要直接运行
node .\reader\build.mjs --desktop-catalog --library-dir ".\Cloudig" --output ".\Cloudig\Data\Reader\Cloudig-Reader.html"
```

构建器把以下固定资源嵌入单文件：

- `vendor/markdown-it-14.3.0.min.js`
- `vendor/temml-render-0.13.3.min.js`
- `vendor/osis-temml-runtime.js`
- `vendor/katex/katex.min.css`
- `vendor/katex/fonts/` 下 12 份固定 WOFF2 字体
- `../library/core.js`
- `src/i18n.js`
- `src/core.js`
- `src/reader.js`
- `src/reader.css`

指定 `--library-dir` 时，构建器会递归读取八个兼容会话版本，把它们与覆盖层引用的安全本地资产、固定 Reader 品牌图和平台图标写入输出 HTML；遇到未知或更新 schema 时仍嵌入该文件，由 Reader 在运行时逐篇隔离并提示，而不会让整个内嵌档案库构建失败。资产上限为单文件 12 MiB、合计 48 MiB，并拒绝符号链接或目录逃逸。`--output` 决定成品位置。未指定时仍生成不含任何会话数据的公开通用版 `reader/reader.html`。

构建不写入时间戳；相同输入会产生相同字节与 SHA-256。

## 回归

```powershell
npm test
npm run test:reader
npm run test:full
npm run test:private
```

`npm test` 是短小的跨工程基线；Reader 实现变化运行 `test:reader`，跨组件或里程碑复核才运行 `test:full`，真实样本另由 `test:private` 明确启动。Reader 公共合同为 193 项、DOM 为 244 项、窗口内桥接为 51 项。34 份三档私有 Parser 门禁通过确定性、身份、资源与分支检查。私有回归只读取本机忽略样本，不会把真实会话、URL 或资源写入 Git。真实 WebView2、Chrome 与逐页内容复核只属于后续验收，不能由自动门禁代替。

实现：GPT-5.6-Sol·奥思·万卷同辉 Osis.MyriadScrollsShineTogether，2026-07-20。
