const freeze = (values) => Object.freeze([...values]);

export const publicRegressionTests = freeze([
  "tests/2026-07-31_Cloudig发布快照与Doctor回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-31_三轨样本外壳审计工具回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-31_三轨样本隐私安全结构保真审计回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_统一JSONSchema验证-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_采云内容时间纯内核回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Reader内容时间V1双读回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Cloudig目录与时间引用V1投影回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1领域命令回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Cloudig内容时间正式界面合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1多文件事务与幂等回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1引用移除计划事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1时间轴同步分叉事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1信封零内容差异回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserParseState1合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1重解析原子事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigV1新资料库与设置权威回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1资料库端到端回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ClaudeJSON到V1档案事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-24_Cloudig身份与资料库迁移回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig资料库覆盖层回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig增量与多会话编排回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-24_Cloudig来源改名与缺失记录回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_CloudigClaude灾后重建回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-21_Cloudig长任务事件流与取消回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-21_Cloudig资料库整体搬家事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-31_Claude官方JSON大文件纯合成压力与取消回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig管理服务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-17_Cloudig档案馆管理回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-24_Cloudig会话目录索引增量回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-24_Cloudig桌面Reader按需读取回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-24_Cloudig用户状态有界恢复回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-24_Cloudig原生桥模块化回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-24_Cloudig发布晋升计划回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-12_Cloudig一键解析计划回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig管理界面合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig封面与Claude管理界面回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-22_Cloudig离线功能文档回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig书签载荷冻结回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_书签状态平台布局回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-17_首轮验收静态合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_十一站书签生命周期与发布门禁回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_API平台分支超时与会话身份回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_DOM平台完整性与会话身份专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_豆包ChatGLMQwen分页身份与对齐专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_三站新鲜页面完整性回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude网页Full-Capture书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude网页全分支取证书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude网页静态图表与分支切换专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude冷页面完整DOM与八图端到端专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude网页附件离线下载按钮专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Full与全分支独立构建注册表合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_ChatGPT全量书签资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_ChatGPT全分支书签树合同-GPT-5.6-Sol.mjs",
  "tests/2026-08-08_ChatGPT生成文件离线捕获-GPT-5.6-Sol.mjs",
  "tests/2026-08-09_ChatGPT记忆来源离线导出-GPT-5.6-Sol.mjs",
  "tests/2026-08-11_ChatGPT临时会话运行时树与资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-08-12_ChatGPT-Scheduled任务页适配-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_ChatGPT列表与可见分支轮次回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_DeepSeek网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Gemini全量书签资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-08-14_Gemini公开思考来源与内嵌全量图片回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Grok网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_豆包全量书签资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_ChatGLM全量书签资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Kimi网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Mistral网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Qwen网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Z.ai网页Full与全分支书签专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_腾讯元宝全量书签资源合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Claude可恢复优先导出专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_六站呈现分支排序与去重定向回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_三站思考Markdown呈现回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Claude用户消息DOM与遍历性能专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-16_ClaudeCowork双入口与线性时间线专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-19_Claude公开搜索图片三级回退专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-09-02_ClaudeChat生成文件离线归档专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-09-05_ClaudeCowork用户上传附件回归-GPT-6-Astra.mjs",
  "tests/2026-07-28_API完整覆盖性能快路专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_十二平台Markdown引用表格图片语义回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_ChatGPTDeepSeek豆包抢救优先专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_KimiQwenChatGLMZai第二轮验收修复专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_十二站抢救优先与来源锁定专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_腾讯元宝多模态隐藏镜像正文专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_五站Mermaid原位切换与元宝Kimi保真专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_五站Mermaid语义与Grok折叠专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_三站Mermaid离线图兜底专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_Mistral任务Mermaid与分支标记专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_ChatGPTDeepSeek原生Mermaid捕获端到端专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_QwenMermaid清理端到端专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_Z.ai原生Mermaid控件壳端到端回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_GrokQwenZai语义保真专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_Z.ai正文Mermaid原位配对专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_三十二轨零可见诊断与统一元数据专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_当前32书签统一构建入口回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_Parser公共合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-13_ChatGPT-Scheduled解析与第三方角色回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-14_Gemini公开思考来源与图片回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-31_Parser分支图公共合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-24_Parser消毒器零删除回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_Reader公共离线回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-25_Reader离线KaTeX公式资源回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_ReaderDOM运行回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_CloudigClaude分支ReaderDOM回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig窗口内Reader回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_隐私与冻结边界回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-08_回归测试分层调度器-GPT-5.6-Sol.mjs"
]);

export const privateRegressionTests = freeze([
  "tests/2026-07-31_Parser三轨私有回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig管理服务十二份私有导入回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-22_Cloudig十二份私有增量回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_Parser十二份私有回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-25_元宝思考静态公式保真回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_Reader十二份私有回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_Reader十二份DOM私有回归-GPT-5.6-Sol.mjs"
]);

const fastTests = freeze([
  "tests/2026-07-20_统一JSONSchema验证-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_采云内容时间纯内核回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Reader内容时间V1双读回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Cloudig目录与时间引用V1投影回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1领域命令回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_Cloudig内容时间正式界面合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1多文件事务与幂等回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1引用移除计划事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigLibrary1时间轴同步分叉事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1信封零内容差异回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserParseState1合同回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1重解析原子事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_CloudigV1新资料库与设置权威回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ParserV1资料库端到端回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-26_ClaudeJSON到V1档案事务回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_书签状态平台布局回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-27_Full与全分支独立构建注册表合同-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_十二平台Markdown引用表格图片语义回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_十二站抢救优先与来源锁定专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-29_三十二轨零可见诊断与统一元数据专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-28_当前32书签统一构建入口回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-13_ChatGPT-Scheduled解析与第三方角色回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_隐私与冻结边界回归-GPT-5.6-Sol.mjs",
  "tests/2026-08-08_回归测试分层调度器-GPT-5.6-Sol.mjs"
]);

const slowTests = freeze([
  "tests/2026-07-31_Cloudig发布快照与Doctor回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-31_Claude官方JSON大文件纯合成压力与取消回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-26_Claude冷页面完整DOM与八图端到端专项回归-GPT-5.6-Sol.mjs",
  "tests/2026-07-20_ReaderDOM运行回归-GPT-5.6-Sol.mjs",
  ...privateRegressionTests
]);

const bookmarkletStart = publicRegressionTests.indexOf("tests/2026-07-22_Cloudig书签载荷冻结回归-GPT-5.6-Sol.mjs");
const parserStart = publicRegressionTests.indexOf("tests/2026-07-20_Parser公共合同回归-GPT-5.6-Sol.mjs");
const managerStart = publicRegressionTests.indexOf("tests/2026-08-26_采云内容时间纯内核回归-GPT-5.6-Sol.mjs");

const suites = Object.freeze({
  fast: fastTests,
  bookmarklets: freeze(publicRegressionTests.slice(bookmarkletStart, parserStart)),
  parser: freeze([
    "tests/2026-07-20_统一JSONSchema验证-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_采云内容时间纯内核回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_ParserV1信封零内容差异回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_ParserParseState1合同回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_ParserV1重解析原子事务回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_CloudigV1新资料库与设置权威回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_ParserV1资料库端到端回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_ClaudeJSON到V1档案事务回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-20_Parser公共合同回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-13_ChatGPT-Scheduled解析与第三方角色回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-14_Gemini公开思考来源与图片回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-31_Parser分支图公共合同回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-24_Parser消毒器零删除回归-GPT-5.6-Sol.mjs"
  ]),
  reader: freeze([
    "tests/2026-08-26_采云内容时间纯内核回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_Reader内容时间V1双读回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-26_Cloudig目录与时间引用V1投影回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-20_Reader公共离线回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-25_Reader离线KaTeX公式资源回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-20_ReaderDOM运行回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-22_CloudigClaude分支ReaderDOM回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-22_Cloudig窗口内Reader回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-24_Cloudig桌面Reader按需读取回归-GPT-5.6-Sol.mjs",
    "tests/2026-08-22_Cloudig离线功能文档回归-GPT-5.6-Sol.mjs"
  ]),
  manager: freeze(publicRegressionTests.slice(managerStart, bookmarkletStart)),
  release: freeze([
    "tests/2026-08-24_Cloudig发布晋升计划回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-31_Cloudig发布快照与Doctor回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-31_三轨样本外壳审计工具回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-31_三轨样本隐私安全结构保真审计回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-22_Cloudig书签载荷冻结回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-26_十一站书签生命周期与发布门禁回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-28_当前32书签统一构建入口回归-GPT-5.6-Sol.mjs",
    "tests/2026-07-20_隐私与冻结边界回归-GPT-5.6-Sol.mjs"
  ]),
  full: publicRegressionTests,
  private: freeze([...publicRegressionTests, ...privateRegressionTests])
});

export const regressionSuiteNames = freeze(Object.keys(suites));
export const knownSlowRegressionTests = slowTests;

function orderedUnique(values) {
  const wanted = new Set(values);
  return [...publicRegressionTests, ...privateRegressionTests].filter((test) => wanted.has(test));
}

export function validateRegressionCatalog() {
  const all = [...publicRegressionTests, ...privateRegressionTests];
  if (new Set(all).size !== all.length) throw new Error("regression catalog contains duplicate paths");
  for (const test of all) {
    if (!test.startsWith("tests/") || !test.endsWith(".mjs")) {
      throw new Error(`invalid regression path: ${test}`);
    }
  }
  for (const [name, tests] of Object.entries(suites)) {
    if (tests.length === 0) throw new Error(`regression suite is empty: ${name}`);
    for (const test of tests) {
      if (!all.includes(test)) throw new Error(`regression suite ${name} references an unknown test: ${test}`);
    }
  }
  for (const test of fastTests) {
    if (slowTests.includes(test) || privateRegressionTests.includes(test)) {
      throw new Error(`fast regression suite includes a slow or private test: ${test}`);
    }
  }
  return true;
}

export function selectRegressionTests({
  suite = null,
  scope = null,
  matches = [],
  withFast = false,
  excludeSlow = false
} = {}) {
  validateRegressionCatalog();
  if (suite !== null && !Object.hasOwn(suites, suite)) {
    throw new Error(`unknown regression suite: ${suite}; expected ${regressionSuiteNames.join(", ")}`);
  }
  if (scope !== null && !Object.hasOwn(suites, scope)) {
    throw new Error(`unknown regression scope: ${scope}; expected ${regressionSuiteNames.join(", ")}`);
  }
  if (scope !== null && suite !== null) throw new Error("regression scope cannot be combined with a base suite");
  const normalizedMatches = matches.map((value) => String(value).trim().toLocaleLowerCase("en-US")).filter(Boolean);
  if (scope !== null && normalizedMatches.length === 0) throw new Error("regression scope requires at least one match");
  let selected = suite === null && normalizedMatches.length === 0
    ? [...publicRegressionTests]
    : [...(suite === null ? [] : suites[suite])];
  if (normalizedMatches.length > 0) {
    const matchPool = scope === null
      ? [...publicRegressionTests, ...privateRegressionTests]
      : suites[scope];
    selected.push(...matchPool.filter((test) => {
      const lowered = test.toLocaleLowerCase("en-US");
      return normalizedMatches.some((match) => lowered.includes(match));
    }));
  }
  if (withFast) selected.push(...fastTests);
  selected = orderedUnique(selected);
  if (excludeSlow) selected = selected.filter((test) => !slowTests.includes(test));
  if (selected.length === 0) throw new Error("regression selection is empty");
  return selected;
}
