# Manager 目录：V1共用组件与旧实现库存

当前V1桌面程序的生产图在工程根的 `src/`，不是 `manager/web/`、旧 `ui/` 或root Parser。本文已于2026-09-09按真实边界重整；旧全文可用 `git show e6b20559e93af05073dc09f1c6468a7667312fd8:manager/README.md` 查回，不复制成另一份“当前规范”。

## 当前入口

| 要做什么 | 从哪里进入 |
|---|---|
| 当前水位、未完成项和交付证据 | [PROJECT_STATE](../PROJECT_STATE.md) |
| V1产品合同与内部完整底稿 | [产品路由](../product/README.md) |
| 页面与共享控件 | [src/ui](../src/ui) |
| 解析、阅读、业务命令 | [src/app](../src/app)、[src/engine](../src/engine) |
| Library与文件写入 | [src/adapters/library-data](../src/adapters/library-data)、[src/adapters/storage](../src/adapters/storage) |
| WPF与原生边界 | [src/desktop](../src/desktop) |
| 共用Chrome书签事务 | [windows/Cloudig.Bookmarks](windows/Cloudig.Bookmarks) |
| 便携位置、cache、有限备份 | [现行存储规范](../docs/2026-09-08_采云V1现行工程规范-GPT-6-Astra/Core/01_数据落点缓存与便携运行-GPT-6-Astra.md) |
| Parser版本与Adapter历史 | [现行历史表](../src/adapters/parser/contracts/parser-history.json)；程序内“编辑会话信息→解析详情→Parser版本与适配器沿革” |

## 当前V1如何运行

- 连续本机验收从[启动当前采云测试版.cmd](../启动当前采云测试版.cmd)进入；`../Cloudig-Test/Library`和`Device`不随重新构建清除。
- 普通直启固定EXE使用程序相邻的`Cloudig/`资料库；显式数据根另有Library/Device/cache分工。不可写时要求用户明确选择位置，不暗回C盘，不自动提权。
- 当前UI由WPF/WebView2承载，Engine为本地Node进程；用户须具有WebView2运行时。V1不交付独立Portable Reader。
- 启动第一帧黑底，同一原版Waiting-Sun在网页内解码绘制后才开始Library初始化。不要恢复旧Manager“生成Reader再切换两份HTML”的原生GIF流程。
- 打开Reader/Archiver与刷新列表只观察事实，不自动解析、不复活用户已删除的JSON；解析与写入由明确操作触发。
- 内容时间默认空，首次解析时间、采云编辑时间与文件系统修改时间分开。采云每次写入更新编辑时间，读取不更新；文件mtime不写回JSON。

`manager/web/`、`manager/server.mjs`、旧发布脚本和旧包继续作为库存或历史。它们存在不代表V1引用它们；只有构建脚本、项目引用和明确复用清单能证明现行依赖。当前仍复用的Chrome事务和独立书签安装器见下文。

## Chrome 书签事务

- 档位为轻装（Light）／全量（Full）／整树（Tree），内部键仍为`light/full/all-branches`。三套可增量共存，选择本次档位不卸掉其他档位；无Tree的平台明确使用Full，不复制一个假Tree节点。
- Chrome默认名固定为`{平台}（{轻装|全量|整树}）· {数字版本号}-{Light|Full|Tree} · Cloudig`，不随界面语言变化。例：`ChatGPT（轻装）· 3.1.0-Light · Cloudig`；括号、间隔点与ASCII空格保留，不加“保存”。正式与独立安装器共用`BookmarkDisplayName`。
- 旧自动名可原位更新；用户自定义名保留。已装版高于包内版不降级脚本，改显示名不升书签版本、不修改HTML下载名、注册ID或既有JS。
- 默认正式文件夹为书签栏顶层的`采云 Cloudig`，默认排最前。用户可选择父目录、文件夹名称、是否置顶；内容平铺，无平台子目录。
- 文件夹GUID、安装实例ID与变体ID共同限定受管对象。只管理用户指定文件夹的直属已识别节点；不扫描或认领“书签测试”、别的目录、同名/同URL副本。移出正式文件夹的单项不继续追着管理。
- 首次写Chrome前，先在既有本机设置中保存本次安装实例ID与目标；保存失败则不写Chrome。若Chrome已写入、最终文件夹GUID记录失败，明确提示已更新和重试；重开后沿用已保存的ID认回同一目标，补全记录而不重复安装。正常无变化的安装不重写相同设置；不增加业务Schema、配置文件或全盘认领扫描。
- 所有写入前要求Chrome退出，不强制杀用户进程；优先用户已保存的目标。未配置时选上次使用的profile，其中有Bookmarks Account则优先该份，否则选本地Bookmarks；每次只改所选一份，不连带另一份。此处纠正旧README的本地库断言，不变更已实测的程序选择顺序。显式安装一次完成，卸载仍需确认。
- 事务预检、完整备份、校验、原子写入与验证；失败回滚。回滚前再次核验现存文件仍是本事务结果、备份仍是原始字节；遇后来的外部改动或损坏备份不强制覆盖。每个备份根最多保留最近两组已完成备份，无变化不新建，不删除Chrome自己的.bak。写入前在本组保存`pending-transaction.txt`，全成功或完整回滚后移除；进程中断或回滚未完成时保留，轮换不淘汰这份仍需恢复的备份。此标记只在`appdata/BookmarkBackups/`，不是业务Schema字段或后台任务。
- 目标设置列出已发现的完整合法文件夹集，不因其位于第199项之后就隐藏；仍按原树容量/深度校验，不允许移入受管文件夹自身或其子树。
- 所选库已有同步记录时，同步更新本次受管节点的UniquePosition、摘要与本地修改序号，使文件夹置顶可随启动/同步保留。未同步库不造同步身份，不修改无关同步记录；没有驻留扩展或后台抢排序。真实置顶已获老婆实测通过，来源见[同步感知置顶](../docs/2026-09-08_书签同步感知置顶-GPT-6-Astra.md)。
- 一键全装发送明确平台集合，不发送空数组。界面反馈采用当前主题的前置结果层，成功/失败不能藏在安装页面后面。
- 安装状态区分包内版本、实际已装版本与上游活跃版本；等价百分号编码不误报更新。书签升级短评唯一来源为[BOOKMARKLET_CHANGELOG](../BOOKMARKLET_CHANGELOG.md)，只显示实际相关版本区间。
- V1包的安装字节来自`artifacts/v1-desktop/app/bookmarks/`及其构建来源，不从旧`manager/bookmarks/`的2026.08.08.1快照推断当前版本。开发包可按授权复用冻结书签，正式发行须重新选择当前已验收集合。

## 独立书签测试安装器（不属于V1桌面发行包）

[installers/bookmark-test/00_安装当前书签测试.exe](installers/bookmark-test/00_安装当前书签测试.exe)是独立验收工具；书签候选目录内还有逐字副本。

- 动态读取同级完整32轨严格单行文件，因此升级JS不必重编安装器；不能按pending缩减同级文件，否则缺席受管项会被视为淘汰。
- 用户选择本机Chrome profile，工具只维护“书签测试”文件夹；与正式“采云 Cloudig”目录的所有权分开。
- Chrome运行时拒绝写入；完整备份、两组保留、失败回滚与免逐构建原生自解压均适用。不联网、不执行书签源码。
- 该工具的维护不自动重打V1或旧Manager发布包，也不自动改变V1冻结书签。精确现行版本/哈希见[PROJECT_STATE](../PROJECT_STATE.md)与[书签入口](../bookmarklets/README.md)。

## 构建、验证和发布

`npm.cmd run build:v1:desktop:reuse-bookmarks`仅用于获准的开发态沿用书签；固定输出是`artifacts/v1-desktop/app/`。普通正式构建入口为`npm.cmd run build:v1:desktop`；这不授权重新编写书签。

按改动运行对应`test:v1:*`、`check:v1:types`和`check:v1:desktop-package`。用户旅程使用隔离Library；每次自产缓存需等进程退出后收口。真实程序与设计对照不能由CSS词面测试替代。

发行校验从[release/v1-preflight-spec.json](../release/v1-preflight-spec.json)进入，不用root旧release-spec/Doctor替代。当前开发包仍不是正式V1发布；文档/链接/更新、最终用户验收与发行冻结等剩余项只在[PROJECT_STATE](../PROJECT_STATE.md)维护，不在此复制一套会漂移的进度表。
